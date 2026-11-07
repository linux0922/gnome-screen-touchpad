import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SENSOR = 'net.hadess.SensorProxy';
const SENSOR_PATH = '/net/hadess/SensorProxy';
const DISPLAY = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_PATH = '/org/gnome/Mutter/DisplayConfig';
const ORIENTATIONS = new Map([['normal', 0], ['left-up', 1], ['bottom-up', 2], ['right-up', 3]]);

function busCall(bus, destination, path, iface, method, parameters, cancellable) {
    return new Promise((resolve, reject) => {
        bus.call(destination, path, iface, method, parameters, null,
            Gio.DBusCallFlags.NONE, 4000, cancellable, (connection, result) => {
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
        this.desired = null;
        this.managerId = manager.connect('notify::panel-orientation-managed', () => this.refresh());
        this.orientationId = orientation.connect('notify::has-accelerometer', () => this.refresh());
        this.settingsId = settings.connect('changed::orientation-lock', () => this.refresh());
        this.refresh();
    }

    async refresh() {
        if (!this.allowed())
            return;
        if (this.bus) {
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
                    if (changed.AccelerometerOrientation)
                        this.offer(changed.AccelerometerOrientation.unpack());
                });
            await busCall(bus, SENSOR, SENSOR_PATH, SENSOR, 'ClaimAccelerometer', null, this.cancel);
            await this.readOrientation();
        } catch (error) {
            if (!this.cancel.is_cancelled()) {
                this.bus?.close(null, null);
                this.bus = null;
                console.warn(`屏幕触控板无法读取方向传感器：${error.message}`);
            }
        } finally {
            this.connecting = false;
        }
    }

    async readOrientation() {
        try {
            const [orientation] = await busCall(this.bus, SENSOR, SENSOR_PATH,
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [SENSOR, 'AccelerometerOrientation']), this.cancel);
            this.offer(orientation.unpack());
        } catch (error) {
            if (!this.cancel.is_cancelled())
                console.warn(`屏幕触控板无法读取屏幕方向：${error.message}`);
        }
    }

    offer(orientation) {
        if (!ORIENTATIONS.has(orientation) || this.cancel.is_cancelled())
            return;
        this.desired = ORIENTATIONS.get(orientation);
        this.apply();
    }

    allowed() {
        return !this.cancel.is_cancelled() && !this.settings.get_boolean('orientation-lock') &&
            rotationFallbackAvailable(this.manager, this.orientation);
    }

    async apply() {
        if (this.pending || this.desired === null || !this.allowed())
            return;
        const transform = this.desired;
        this.desired = null;
        this.pending = true;
        try {
            const state = await busCall(Gio.DBus.session, DISPLAY, DISPLAY_PATH, DISPLAY,
                'GetCurrentState', null, this.cancel);
            if (!this.allowed() || this.desired !== null)
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
            if (this.desired !== null && this.allowed())
                this.apply();
        }
    }

    destroy() {
        this.cancel.cancel();
        this.manager.disconnect(this.managerId);
        this.orientation.disconnect(this.orientationId);
        this.settings.disconnect(this.settingsId);
        this.bus?.close(null, null);
        this.bus = null;
    }
}
