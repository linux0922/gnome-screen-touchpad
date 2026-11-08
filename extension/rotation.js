import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SENSOR = 'net.hadess.SensorProxy';
const SENSOR_PATH = '/net/hadess/SensorProxy';
const DISPLAY = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_PATH = '/org/gnome/Mutter/DisplayConfig';
const EXTERNAL_ROTATION = 'io.github.linux0922.ScreenTouchpad.Rotation';
const ACTIVE_POINTER = 'io.github.linux0922.ScreenTouchpad.Pointer';
const SETTLE_MS = 450;
const NATIVE_HANDOFF_US = 900000;
const ORIENTATIONS = new Map([['normal', 0], ['left-up', 1], ['bottom-up', 2], ['right-up', 3]]);

function busCall(bus, destination, path, iface, method, parameters, cancellable, timeout = 4000) {
    return new Promise((resolve, reject) => {
        bus.call(destination, path, iface, method, parameters, null,
            Gio.DBusCallFlags.NONE, timeout, cancellable, (connection, result) => {
                try {
                    resolve(connection.call_finish(result).deepUnpack());
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function connectSystemBus(cancellable) {
    return new Promise((resolve, reject) => {
        const address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SYSTEM, cancellable);
        Gio.DBusConnection.new_for_address(address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
            Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, cancellable,
            (_connection, result) => {
                try {
                    resolve(Gio.DBusConnection.new_for_address_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export function rotationFallbackAvailable(manager, orientation) {
    if (manager.get_panel_orientation_managed() || !orientation.has_accelerometer)
        return false;
    const logical = manager.get_logical_monitors();
    if (logical.length !== 1)
        return false;
    const monitors = logical[0].get_monitors();
    return monitors.length === 1 && monitors[0].is_builtin();
}

// Use temporary monitor changes, and only for a single built-in display.
export function rotationRequest(state, transform) {
    const [serial, monitors, logical, properties] = state;
    if (logical.length !== 1 || logical[0][5].length !== 1)
        return null;
    const [x, y, scale, current, primary, [spec]] = logical[0];
    const monitor = monitors.find(([details]) => details[0] === spec[0]);
    if (!monitor?.[2]['is-builtin']?.unpack() || current === transform)
        return null;
    const mode = monitor[1].find(entry => entry[6]['is-current']?.unpack());
    if (!mode)
        return null;
    const monitorProps = {};
    for (const key of ['underscanning', 'color-mode', 'rgb-range']) {
        if (monitor[2][key])
            monitorProps[key] = monitor[2][key];
    }
    const config = properties['layout-mode'] ? {'layout-mode': properties['layout-mode']} : {};
    return new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [
        serial, 1, [[x, y, scale, transform, primary, [[spec[0], mode[0], monitorProps]]]], config,
    ]);
}

export class Rotation {
    constructor(manager, orientation, settings) {
        this.manager = manager;
        this.orientation = orientation;
        this.settings = settings;
        this.cancel = new Gio.Cancellable();
        this.bus = null;
        this.pending = false;
        this.target = null;
        this.lastRequested = null;
        this.timer = 0;
        this.sensorRevision = 0;
        this.eligible = false;
        this.sensorReady = false;
        this.pointerOwner = 0;
        this.handoff = null;
        this.handoffTimer = 0;
        this.restoring = false;
        this.ignoreInitialReading = false;
        // Wait for the initial name lookup before touching display configuration.
        this.external = true;
        this.externalWatch = Gio.bus_watch_name_on_connection(Gio.DBus.session, EXTERNAL_ROTATION,
            Gio.BusNameWatcherFlags.NONE, () => this.setExternal(true), () => this.setExternal(false));
        this.nativeSince = manager.get_panel_orientation_managed() ? GLib.get_monotonic_time() : 0;
        this.managerId = manager.connect('notify::panel-orientation-managed', () => this.nativeChanged());
        this.orientationId = orientation.connect('notify::has-accelerometer', () => this.refresh());
        this.settingsId = settings.connect('changed::orientation-lock', () => {
            this.lastRequested = null;
            this.ignoreInitialReading = false;
            this.initialReading = undefined;
            this.refresh();
        });
    }

    async preparePointer() {
        this.handoff = null;
        this.ignoreInitialReading = true;
        if (!this.manager.get_panel_orientation_managed())
            return;
        try {
            const [, , logical] = await busCall(Gio.DBus.session, DISPLAY, DISPLAY_PATH, DISPLAY,
                'GetCurrentState', null, this.cancel, 350);
            if (logical.length === 1 && logical[0][5].length === 1)
                this.handoff = {transform: logical[0][3], connector: logical[0][5][0][0]};
        } catch (error) {
            if (!this.cancel.is_cancelled())
                console.warn(`屏幕触控板无法读取当前显示方向：${error.message}`);
        }
    }

    pointerCreated() {
        this.pointerOwner = Gio.bus_own_name_on_connection(Gio.DBus.session, ACTIVE_POINTER,
            Gio.BusNameOwnerFlags.DO_NOT_QUEUE, null, null);
        if (this.handoff && this.manager.get_panel_orientation_managed()) {
            this.handoffTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
                this.handoffTimer = 0;
                this.handoff = null;
                this.refresh();
                return GLib.SOURCE_REMOVE;
            });
        }
        this.restoreHandoff();
        this.refresh();
    }

    async restoreHandoff() {
        if (!this.pointerOwner || !this.handoff || this.manager.get_panel_orientation_managed())
            return;
        const {transform, connector} = this.handoff;
        this.clearHandoffTimer();
        this.handoff = null;
        if (!rotationFallbackAvailable(this.manager, this.orientation))
            return;
        this.restoring = true;
        try {
            const state = await busCall(Gio.DBus.session, DISPLAY, DISPLAY_PATH, DISPLAY,
                'GetCurrentState', null, this.cancel);
            if (this.cancel.is_cancelled() || !rotationFallbackAvailable(this.manager, this.orientation) ||
                state[2][0]?.[5][0]?.[0] !== connector)
                return;
            const request = rotationRequest(state, transform);
            if (request) {
                await busCall(Gio.DBus.session, DISPLAY, DISPLAY_PATH, DISPLAY,
                    'ApplyMonitorsConfig', request, this.cancel);
            }
        } catch (error) {
            if (!this.cancel.is_cancelled())
                console.warn(`屏幕触控板无法保留当前显示方向：${error.message}`);
        } finally {
            this.restoring = false;
            this.refresh();
        }
    }

    clearHandoffTimer() {
        if (this.handoffTimer) {
            GLib.Source.remove(this.handoffTimer);
            this.handoffTimer = 0;
        }
    }

    setExternal(external) {
        this.external = external;
        this.lastRequested = null;
        this.refresh();
    }

    nativeChanged() {
        const now = GLib.get_monotonic_time();
        if (this.manager.get_panel_orientation_managed()) {
            this.nativeSince = now;
        } else {
            if (this.nativeSince && now - this.nativeSince >= NATIVE_HANDOFF_US)
                this.lastRequested = null;
            this.nativeSince = 0;
        }
        this.restoreHandoff();
        this.refresh();
    }

    async refresh() {
        const eligible = this.allowed();
        if (eligible === this.eligible)
            return;
        this.eligible = eligible;
        this.sensorRevision++;
        this.sensorReady = false;
        if (!eligible) {
            this.clearTimer();
            return;
        }
        if (this.bus) {
            if (!this.connecting)
                this.readOrientation();
            return;
        }
        if (this.connecting)
            return;
        this.connecting = true;
        try {
            // A separate bus owner keeps our sensor claim independent from Mutter's claim.
            const bus = await connectSystemBus(this.cancel);
            if (this.cancel.is_cancelled()) {
                bus.close(null, null);
                return;
            }
            this.bus = bus;
            bus.signal_subscribe(SENSOR, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                SENSOR_PATH, SENSOR, Gio.DBusSignalFlags.NONE,
                (_bus, _sender, _path, _interface, _signal, params) => {
                    const [, changed] = params.deepUnpack();
                    if (changed.AccelerometerOrientation) {
                        this.sensorRevision++;
                        this.offer(changed.AccelerometerOrientation.unpack());
                    }
                });
            await busCall(bus, SENSOR, SENSOR_PATH, SENSOR, 'ClaimAccelerometer', null, this.cancel);
            await this.readOrientation();
        } catch (error) {
            if (!this.cancel.is_cancelled()) {
                this.bus?.close(null, null);
                this.bus = null;
                this.eligible = false;
                console.warn(`屏幕触控板无法读取方向传感器：${error.message}`);
            }
        } finally {
            this.connecting = false;
        }
    }

    async readOrientation() {
        const revision = this.sensorRevision;
        try {
            const [orientation] = await busCall(this.bus, SENSOR, SENSOR_PATH,
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [SENSOR, 'AccelerometerOrientation']), this.cancel);
            if (revision === this.sensorRevision)
                this.offer(orientation.unpack());
        } catch (error) {
            if (!this.cancel.is_cancelled())
                console.warn(`屏幕触控板无法读取屏幕方向：${error.message}`);
        }
    }

    offer(orientation) {
        if (!this.allowed())
            return;
        const target = ORIENTATIONS.get(orientation) ?? null;
        if (this.ignoreInitialReading && target !== null) {
            this.ignoreInitialReading = false;
            this.initialReading = target;
        }
        if (this.initialReading !== undefined) {
            if (target === null || target === this.initialReading)
                return;
            this.initialReading = undefined;
        }
        this.sensorReady = true;
        if (target !== this.target) {
            this.target = target;
            this.lastRequested = null;
            this.clearTimer();
        }
        if (target !== null && target !== this.lastRequested && !this.timer) {
            this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
                this.timer = 0;
                this.apply();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    clearTimer() {
        if (this.timer) {
            GLib.Source.remove(this.timer);
            this.timer = 0;
        }
    }

    allowed() {
        return this.pointerOwner !== 0 && !this.handoff && !this.restoring && !this.external &&
            !this.cancel.is_cancelled() && !this.settings.get_boolean('orientation-lock') &&
            rotationFallbackAvailable(this.manager, this.orientation);
    }

    async apply() {
        if (!this.sensorReady || this.pending || this.timer || this.target === null ||
            this.target === this.lastRequested || !this.allowed())
            return;
        const transform = this.target;
        // A display change (even a reversion) must not reapply the same reading.
        this.lastRequested = transform;
        this.pending = true;
        try {
            const state = await busCall(Gio.DBus.session, DISPLAY, DISPLAY_PATH, DISPLAY,
                'GetCurrentState', null, this.cancel);
            if (!this.sensorReady || !this.allowed() || this.timer || this.target !== transform)
                return;
            const request = rotationRequest(state, transform);
            if (request) {
                await busCall(Gio.DBus.session, DISPLAY, DISPLAY_PATH, DISPLAY,
                    'ApplyMonitorsConfig', request, this.cancel);
            }
        } catch (error) {
            if (!this.cancel.is_cancelled())
                console.warn(`屏幕触控板无法自动旋转：${error.message}`);
        } finally {
            this.pending = false;
            this.apply();
        }
    }

    destroy() {
        this.cancel.cancel();
        this.clearTimer();
        this.clearHandoffTimer();
        Gio.bus_unwatch_name(this.externalWatch);
        if (this.pointerOwner)
            Gio.bus_unown_name(this.pointerOwner);
        this.manager.disconnect(this.managerId);
        this.orientation.disconnect(this.orientationId);
        this.settings.disconnect(this.settingsId);
        this.bus?.close(null, null);
        this.bus = null;
    }
}
