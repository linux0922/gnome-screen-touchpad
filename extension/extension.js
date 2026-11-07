import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import System from 'system';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Rotation, rotationFallbackAvailable} from './rotation.js';

const ICON = 'input-touchpad-symbolic';
const VERTICAL = Clutter.Orientation.VERTICAL;
const ET = Clutter.EventType;
const PASS = Clutter.EVENT_PROPAGATE;
const STOP = Clutter.EVENT_STOP;
const SCROLL_END = Clutter.ScrollFinishFlags.HORIZONTAL | Clutter.ScrollFinishFlags.VERTICAL;
const TAP_TIMEOUT_US = 420000;
const DOUBLE_TAP_TIMEOUT_MS = 280;
const DOUBLE_TAP_RADIUS = 28;
const GESTURE_TIMEOUT_MS = 5000;
const POINTER_FOCUS_GRACE_MS = 120;
const CURSOR_HANDOFF_MS = 120;
const OPACITY = {key: 'opacity', label: '不透明度', min: 50, max: 100};
const SENSITIVITY = {key: 'sensitivity', label: '鼠标灵敏度', min: 25, max: 200};
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

function settingSlider(settings, {key, label, min, max}) {
    const row = new St.BoxLayout({style_class: 'screen-touchpad-setting', x_expand: true});
    const slider = new Slider(0);
    slider.x_expand = true;
    slider.accessible_name = label;
    const value = new St.Label({style_class: 'screen-touchpad-setting-value',
        y_align: Clutter.ActorAlign.CENTER});
    row.add_child(new St.Label({text: label, style_class: 'screen-touchpad-setting-label',
        y_align: Clutter.ActorAlign.CENTER}));
    row.add_child(slider);
    row.add_child(value);

    const sync = () => {
        const percent = settings.get_int(key);
        slider.value = (percent - min) / (max - min);
        value.text = `${percent}%`;
    };
    const changedId = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(changedId));
    sync();
    slider.connect('notify::value', () => {
        const percent = Math.round(min + slider.value * (max - min));
        if (percent !== settings.get_int(key))
            settings.set_int(key, percent);
    });
    return row;
}

class GestureCursor {
    constructor(seat) {
        this.seat = seat;
        this.tracker = global.backend.get_cursor_tracker();
        this.actor = new Clutter.Actor({reactive: false, visible: false});
        this.active = false;
        this.inhibited = false;
        this.handoff = 0;
        Main.uiGroup.add_child(this.actor);
    }

    begin() {
        this.clearHandoff();
        if (this.active || Main.magnifier?.isActive())
            return;
        this.active = true;
        this.seat.inhibit_unfocus();
        this.cursorId = this.tracker.connect('cursor-changed', () => this.updateTexture());
        this.positionId = this.tracker.connect('position-invalidated', () => {
            if (this.texture)
                this.updateGeometry();
            else
                this.updateTexture();
        });
        this.updateTexture();
    }

    updateTexture() {
        const texture = this.tracker.get_sprite();
        if (this.texture !== texture) {
            this.texture = texture;
            this.actor.content = texture ? Clutter.TextureContent.new_from_texture(texture, null) : null;
        } else {
            this.actor.content?.invalidate();
        }
        if (!texture) {
            this.actor.hide();
            this.setInhibited(false);
            return;
        }
        this.updateGeometry();
        this.actor.show();
        this.setInhibited(true);
    }

    updateGeometry() {
        const width = this.texture.get_width();
        const height = this.texture.get_height();
        const textureScale = this.tracker.get_scale();
        const [hotX, hotY] = this.tracker.get_hot();
        const [x, y] = global.get_pointer();
        const monitor = Main.layoutManager.monitors.find(({x: left, y: top, width: w, height: h}) =>
            x >= left && x < left + w && y >= top && y < top + h);
        const density = monitor ? Math.ceil(global.display.get_monitor_scale(monitor.index)) : 1;
        // Mutter's theme cursors can carry a logical viewport size separate
        // from the reported texture scale. Avoid applying monitor density twice.
        let scale = textureScale;
        if (textureScale === 1 && density > 1) {
            const textureDensity = Math.round(Math.max(width, height) / Meta.prefs_get_cursor_size());
            scale /= clamp(textureDensity, 1, density);
        }
        this.actor.set_size(width * scale, height * scale);
        this.actor.set_position(x - hotX * scale, y - hotY * scale);
    }

    setInhibited(inhibit) {
        if (inhibit === this.inhibited)
            return;
        this.inhibited = inhibit;
        if (inhibit)
            this.tracker.inhibit_cursor_visibility();
        else
            this.tracker.uninhibit_cursor_visibility();
    }

    finish() {
        if (!this.active || this.handoff)
            return;
        // Keep the cursor visible until Mutter processes the final touch and motion.
        this.handoff = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CURSOR_HANDOFF_MS, () => {
            this.handoff = 0;
            this.stop();
            return GLib.SOURCE_REMOVE;
        });
    }

    clearHandoff() {
        if (this.handoff) {
            GLib.Source.remove(this.handoff);
            this.handoff = 0;
        }
    }

    stop() {
        this.clearHandoff();
        if (!this.active)
            return;
        this.active = false;
        this.tracker.disconnect(this.cursorId);
        this.tracker.disconnect(this.positionId);
        this.actor.hide();
        this.actor.content = null;
        this.texture = null;
        this.setInhibited(false);
        this.seat.uninhibit_unfocus();
    }

    destroy() {
        this.stop();
        this.actor.destroy();
    }
}

class Pad {
    constructor(onClose, geometry, rotationSettings, preferences) {
        this.geometry = geometry;
        this.preferences = preferences;
        this.contacts = new Map();
        this.gesture = null;
        this.edit = null;
        this.dragging = false;
        this.dragFilter = 0;
        this.pendingTap = null;
        this.gestureTimeout = 0;
        this.motionSource = 0;
        this.focusSource = 0;
        this.dx = 0;
        this.dy = 0;
        this.seat = global.stage.context.get_backend().get_default_seat();

        this.actor = new St.BoxLayout({
            style_class: 'screen-touchpad', orientation: VERTICAL, reactive: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });
        const header = this.row();
        this.grip = new St.Label({text: '⠿  屏幕触控板', style_class: 'screen-touchpad-grip',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true});
        header.add_child(this.grip);
        this.settingsButton = new St.Button({
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
            style_class: 'screen-touchpad-button', accessible_name: '触控板设置',
            toggle_mode: true, can_focus: true,
        });
        header.add_child(this.settingsButton);
        header.add_child(this.button('−', '缩小触控板', () => this.adjustSize(-1)));
        header.add_child(this.button('+', '放大触控板', () => this.adjustSize(1)));
        const close = this.button('×', '关闭屏幕触控板', onClose);
        close.add_style_class_name('screen-touchpad-close');
        header.add_child(close);
        this.actor.add_child(header);
        this.bindGrip(this.grip, false);

        const surfaces = this.row();
        surfaces.y_expand = true;
        this.surface = this.area('单指移动 · 轻点左键\n双指滚动 · 轻点右键\n轻点，再按住拖动',
            'screen-touchpad-surface', true);
        this.strip = this.area('↕\n滚动', 'screen-touchpad-strip', false);
        this.strip.width = 46;
        surfaces.add_child(this.surface);
        surfaces.add_child(this.strip);
        this.actor.add_child(surfaces);
        this.surface.connect('touch-event', (_actor, event) => this.touch(event, false));
        this.strip.connect('touch-event', (_actor, event) => this.touch(event, true));

        this.settingsPanel = new St.BoxLayout({
            style_class: 'screen-touchpad-surface screen-touchpad-settings',
            orientation: VERTICAL, y_expand: true, visible: false,
        });
        this.settingsPanel.add_child(settingSlider(preferences, OPACITY));
        this.settingsPanel.add_child(settingSlider(preferences, SENSITIVITY));
        this.actor.add_child(this.settingsPanel);
        this.settingsButton.connect('notify::checked', () => {
            this.cancelGesture();
            surfaces.visible = !this.settingsButton.checked;
            this.settingsPanel.visible = this.settingsButton.checked;
        });

        const footer = this.row();
        for (const [label, button] of [['左键', 1], ['右键', 3]]) {
            const control = this.button(label, `点击${label}`, () => {
                this.takePendingTap();
                this.click(button);
            });
            control.x_expand = true;
            control.add_style_class_name('screen-touchpad-action');
            footer.add_child(control);
        }
        this.resize = new St.Label({text: '◢', style_class: 'screen-touchpad-grip',
            reactive: true, accessible_name: '拖动调整触控板大小'});
        footer.add_child(this.resize);
        this.actor.add_child(footer);
        this.bindGrip(this.resize, true);

        const syncOpacity = () => {
            this.actor.opacity = Math.round(preferences.get_int(OPACITY.key) * 255 / OPACITY.max);
        };
        const syncSensitivity = () => {
            this.motionGain = 1.6 * preferences.get_int(SENSITIVITY.key) / 100;
        };
        this.opacityId = preferences.connect('changed::opacity', syncOpacity);
        this.sensitivityId = preferences.connect('changed::sensitivity', syncSensitivity);
        syncOpacity();
        syncSensitivity();

        Main.layoutManager.addChrome(this.actor);
        this.reflow();
        this.cursor = new GestureCursor(this.seat);
        this.device = this.seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this.rotation = new Rotation(global.backend.get_monitor_manager(),
            global.backend.get_orientation_manager(), rotationSettings);

        this.actor.connect('notify::mapped', () => {
            if (!this.actor.mapped)
                this.cancelGesture();
        });
        this.monitorId = Main.layoutManager.connect('monitors-changed', () => {
            this.cancelGesture();
            this.reflow();
            this.rotation.refresh();
        });
        this.overviewId = Main.overview.connect('showing', () => {
            this.actor.hide();
        });
        this.overviewHiddenId = Main.overview.connect('hidden', () => {
            this.reflow();
            this.actor.show();
        });
    }

    row() {
        return new St.BoxLayout({style_class: 'screen-touchpad-row'});
    }

    area(text, styleClass, expand) {
        const area = new St.Widget({style_class: styleClass, reactive: true, x_expand: expand,
            layout_manager: new Clutter.BinLayout()});
        area.add_child(new St.Label({text, style_class: 'screen-touchpad-hint',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        return area;
    }

    button(label, accessibleName, action) {
        const button = new St.Button({label, accessible_name: accessibleName,
            style_class: 'screen-touchpad-button', can_focus: true});
        button.connect('clicked', action);
        return button;
    }

    reflow() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const width = Math.round(clamp(this.geometry.width, 294, Math.max(294, work.width - 24)));
        const height = Math.round(clamp(this.geometry.height, 180, Math.max(180, work.height - 24)));
        const x = Math.round(clamp(this.geometry.x ?? work.x + work.width - width - 24,
            work.x + 6, work.x + work.width - width - 6));
        const y = Math.round(clamp(this.geometry.y ?? work.y + work.height - height - 28,
            work.y + 6, work.y + work.height - height - 6));
        this.actor.set_size(width, height);
        this.actor.set_position(x, y);
    }

    adjustSize(direction) {
        this.geometry.width = this.actor.width + 48 * direction;
        this.geometry.height = this.actor.height + 26 * direction;
        this.reflow();
    }

    queueMotion(dx = 0, dy = 0) {
        this.dx += dx;
        this.dy += dy;
        if (this.motionSource)
            return;
        this.keepPointerFocus();
        this.motionSource = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.motionSource = 0;
            this.flushMotion();
            return GLib.SOURCE_REMOVE;
        });
    }

    flushMotion() {
        if (this.motionSource) {
            GLib.Source.remove(this.motionSource);
            this.motionSource = 0;
        }
        this.keepPointerFocus();
        this.device.notify_relative_motion(GLib.get_monotonic_time(), this.dx, this.dy);
        this.dx = this.dy = 0;
    }

    keepPointerFocus() {
        // Mutter can repick the target before its cursor is visible again.
        // Keep focus only while the queued pointer event is being delivered.
        if (this.focusSource)
            GLib.Source.remove(this.focusSource);
        else
            this.seat.inhibit_unfocus();
        this.focusSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_FOCUS_GRACE_MS, () => {
            this.focusSource = 0;
            this.seat.uninhibit_unfocus();
            return GLib.SOURCE_REMOVE;
        });
    }

    sendButton(button, pressed) {
        this.device.notify_button(GLib.get_monotonic_time(), button,
            pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    }

    click(button, count = 1) {
        if (this.pointerOnPad())
            return;
        // Refresh the native cursor and pointer focus before sending the click.
        this.flushMotion();
        for (let i = 0; i < count; i++) {
            this.sendButton(button, true);
            this.sendButton(button, false);
        }
    }

    queueTap(x, y) {
        if (this.pointerOnPad())
            return;
        const [pointerX, pointerY] = global.get_pointer();
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DOUBLE_TAP_TIMEOUT_MS, () => {
            const tap = this.pendingTap;
            this.pendingTap = null;
            this.commitTap(tap);
            return GLib.SOURCE_REMOVE;
        });
        this.pendingTap = {x, y, pointerX, pointerY, source};
    }

    takePendingTap() {
        const tap = this.pendingTap;
        if (tap) {
            GLib.Source.remove(tap.source);
            this.pendingTap = null;
        }
        return tap;
    }

    samePointerTarget(tap) {
        const [x, y] = global.get_pointer();
        return Math.hypot(x - tap.pointerX, y - tap.pointerY) <= 4;
    }

    commitTap(tap) {
        if (tap && this.samePointerTarget(tap))
            this.click(1);
    }

    pointerOnPad() {
        const [x, y] = global.get_pointer();
        const [left, top] = this.actor.get_transformed_position();
        const [width, height] = this.actor.get_transformed_size();
        return x >= left && x < left + width && y >= top && y < top + height;
    }

    scroll(dx, dy, finish = false) {
        this.device.notify_scroll_continuous(GLib.get_monotonic_time(), dx, dy,
            Clutter.ScrollSource.FINGER, finish ? SCROLL_END : Clutter.ScrollFinishFlags.NONE);
    }

    startDrag(key) {
        if (this.pointerOnPad())
            return;
        this.flushMotion();
        this.sendButton(1, true);
        this.dragging = true;
        const device = this.contacts.get(key).device;
        // A compositor window move takes the stage grab away from the pad.
        // Only forward this already-active touch sequence through that grab.
        this.dragFilter = Clutter.event_add_filter(global.stage, event => {
            const kind = event.type();
            if (kind !== ET.TOUCH_UPDATE && kind !== ET.TOUCH_END && kind !== ET.TOUCH_CANCEL)
                return PASS;
            if (!global.display.is_grabbed())
                return PASS;
            if (event.get_source_device() !== device || event.get_event_sequence()?.get_slot() !== key)
                return PASS;
            const [x, y] = event.get_coords();
            this.updateTouch(key, kind, x, y);
            return STOP;
        });
    }

    watchGesture() {
        this.clearGestureTimeout();
        this.gestureTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GESTURE_TIMEOUT_MS, () => {
            this.gestureTimeout = 0;
            this.cancelGesture();
            return GLib.SOURCE_REMOVE;
        });
    }

    clearGestureTimeout() {
        if (this.gestureTimeout) {
            GLib.Source.remove(this.gestureTimeout);
            this.gestureTimeout = 0;
        }
    }

    endDrag() {
        if (this.dragFilter) {
            Clutter.event_remove_filter(this.dragFilter);
            this.dragFilter = 0;
        }
        if (this.dragging) {
            this.flushMotion();
            this.sendButton(1, false);
            this.dragging = false;
        }
    }

    cancelGesture() {
        this.clearGestureTimeout();
        this.endDrag();
        if (this.gesture?.scrolling)
            this.scroll(0, 0, true);
        this.gesture = null;
        this.contacts.clear();
        this.takePendingTap();
        this.edit = null;
        if (this.motionSource) {
            GLib.Source.remove(this.motionSource);
            this.motionSource = 0;
        }
        this.dx = this.dy = 0;
        this.cursor.stop();
    }

    bindGrip(actor, resize) {
        const handle = (_actor, event) => {
            const kind = event.type();
            const touch = event.get_event_sequence();
            const key = touch ? touch.get_slot() : 'mouse';
            const [x, y] = event.get_coords();
            if (kind === ET.TOUCH_BEGIN || kind === ET.BUTTON_PRESS && event.get_button() === 1) {
                if (this.contacts.size || this.edit)
                    return PASS;
                this.takePendingTap();
                this.edit = {actor, key, x, y, left: this.actor.x, top: this.actor.y,
                    width: this.actor.width, height: this.actor.height};
                return STOP;
            }
            if (this.edit?.actor !== actor || this.edit.key !== key)
                return PASS;
            if (kind === ET.TOUCH_UPDATE || kind === ET.MOTION) {
                const dx = x - this.edit.x;
                const dy = y - this.edit.y;
                if (resize) {
                    this.geometry.width = this.edit.width + dx;
                    this.geometry.height = this.edit.height + dy;
                } else {
                    this.geometry.x = this.edit.left + dx;
                    this.geometry.y = this.edit.top + dy;
                }
                this.reflow();
            } else {
                this.edit = null;
            }
            return STOP;
        };
        for (const signal of ['touch-event', 'button-press-event', 'button-release-event', 'motion-event'])
            actor.connect(signal, handle);
    }

    touch(event, strip) {
        if (!this.actor.mapped || Main.sessionMode.isLocked)
            return PASS;
        const key = event.get_event_sequence()?.get_slot();
        if (key === undefined)
            return PASS;
        const kind = event.type();
        const [x, y] = event.get_coords();
        if (kind === ET.TOUCH_BEGIN) {
            this.edit = null;
            if (this.contacts.has(key))
                this.cancelGesture();
            if (this.gesture && this.gesture.strip !== strip)
                return PASS;
            this.beginTouch(key, x, y, strip, event.get_source_device());
            return STOP;
        }
        if (!this.contacts.has(key))
            return PASS;
        this.updateTouch(key, kind, x, y);
        return STOP;
    }

    beginTouch(key, x, y, strip, device) {
        this.queueMotion();
        const time = GLib.get_monotonic_time();
        if (!this.contacts.size) {
            this.cursor.begin();
            const tap = this.takePendingTap();
            const dragCandidate = !strip && tap && this.samePointerTarget(tap) &&
                Math.hypot(x - tap.x, y - tap.y) <= DOUBLE_TAP_RADIUS;
            if (!dragCandidate)
                this.commitTap(tap);
            this.gesture = {strip, max: 0, moved: false, scrolling: false, start: time, dragCandidate};
        } else {
            this.gesture.dragCandidate = false;
            this.endDrag();
        }
        this.contacts.set(key, {x, y, initialX: x, initialY: y, device});
        this.gesture.max = Math.max(this.gesture.max, this.contacts.size);
        this.watchGesture();
    }

    updateTouch(key, kind, x, y) {
        if (kind === ET.TOUCH_CANCEL) {
            this.cancelGesture();
            return;
        }
        if (kind !== ET.TOUCH_UPDATE && kind !== ET.TOUCH_END)
            return;
        const point = this.contacts.get(key);
        const gesture = this.gesture;
        const count = this.contacts.size;
        let dx = x - point.x;
        let dy = y - point.y;
        point.x = x;
        point.y = y;
        // A release can arrive without an update. Treat a displaced release as movement,
        // but only begin a drag while the second tap is still down.
        if (!gesture.moved && Math.hypot(x - point.initialX, y - point.initialY) >= 5) {
            gesture.moved = true;
            dx = x - point.initialX;
            dy = y - point.initialY;
            if (kind === ET.TOUCH_UPDATE && gesture.dragCandidate && count === 1)
                this.startDrag(key);
        }
        if (gesture.moved && (dx || dy) && count === gesture.max) {
            if (gesture.strip && count === 1 || !gesture.strip && count === 2) {
                const gain = gesture.strip ? 1.25 : .65;
                this.scroll(gesture.strip ? 0 : -dx * gain, -dy * gain);
                gesture.scrolling = true;
            } else if (!gesture.strip && count === 1) {
                this.queueMotion(dx * this.motionGain, dy * this.motionGain);
            }
        }
        // Refresh Mutter's pointer after physical touch, including the final lift.
        this.queueMotion();
        this.watchGesture();

        if (kind !== ET.TOUCH_END)
            return;
        this.contacts.delete(key);
        if (gesture.scrolling) {
            this.scroll(0, 0, true);
            gesture.scrolling = false;
        }
        if (!this.contacts.size) {
            this.clearGestureTimeout();
            this.endDrag();
            const time = GLib.get_monotonic_time();
            if (!gesture.strip && !gesture.moved && gesture.max <= 2 && time - gesture.start < TAP_TIMEOUT_US) {
                if (gesture.max === 2)
                    this.click(3);
                else if (gesture.dragCandidate)
                    this.click(1, 2);
                else
                    this.queueTap(x, y);
            }
            this.gesture = null;
            this.cursor.finish();
        }
    }

    destroy() {
        this.preferences.disconnect(this.opacityId);
        this.preferences.disconnect(this.sensitivityId);
        Main.layoutManager.disconnect(this.monitorId);
        Main.overview.disconnect(this.overviewId);
        Main.overview.disconnect(this.overviewHiddenId);
        this.cancelGesture();
        this.cursor.destroy();
        this.rotation.destroy();
        this.actor.destroy();
        this.device = null;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            System.gc();
            return GLib.SOURCE_REMOVE;
        });
    }
}

export default class ScreenTouchpadExtension extends Extension {
    enable() {
        this._geometry = {width: 440, height: 236};
        this._settings = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.peripherals.touchscreen'});
        this._preferences = this.getSettings();
        this._monitorManager = global.backend.get_monitor_manager();
        this._orientationManager = global.backend.get_orientation_manager();
        this._indicator = new QuickSettings.SystemIndicator();
        this._toggle = new QuickSettings.QuickMenuToggle({
            title: '屏幕触控板', icon_name: ICON, toggle_mode: true,
        });
        this._toggle.menu.setHeader(ICON, '屏幕触控板', '用触摸屏控制系统鼠标');
        const lock = new PopupMenu.PopupSwitchMenuItem('锁定屏幕旋转',
            this._settings.get_boolean('orientation-lock'));
        lock.connect('toggled', (_item, checked) => this._settings.set_boolean('orientation-lock', checked));
        this._toggle.menu.addMenuItem(lock);
        const opacityItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        opacityItem.remove_style_class_name('popup-inactive-menu-item');
        opacityItem.add_child(settingSlider(this._preferences, OPACITY));
        this._toggle.menu.addMenuItem(opacityItem);
        this._toggle.connect('notify::checked', () => this._sync());

        this._rotationToggle = new QuickSettings.QuickToggle({
            title: '自动旋转', toggle_mode: true, visible: false,
        });
        this._settings.bind('orientation-lock', this._rotationToggle, 'checked',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);
        const syncLock = () => {
            const locked = this._settings.get_boolean('orientation-lock');
            lock.setToggleState(locked);
            this._rotationToggle.icon_name = locked ? 'rotation-locked-symbolic' : 'rotation-allowed-symbolic';
        };
        this._lockId = this._settings.connect('changed::orientation-lock', syncLock);
        syncLock();
        const syncVisibility = () => this._syncRotationVisibility();
        this._rotationMonitorId = this._monitorManager.connect('notify::panel-orientation-managed', syncVisibility);
        this._rotationSensorId = this._orientationManager.connect('notify::has-accelerometer', syncVisibility);
        this._rotationLayoutId = Main.layoutManager.connect('monitors-changed', syncVisibility);
        this._indicator.quickSettingsItems.push(this._toggle, this._rotationToggle);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    _syncRotationVisibility() {
        this._rotationToggle.visible = Boolean(this._pad) &&
            rotationFallbackAvailable(this._monitorManager, this._orientationManager);
    }

    _sync() {
        if (this._toggle.checked && !this._pad) {
            this._pad = new Pad(() => { this._toggle.checked = false; },
                this._geometry, this._settings, this._preferences);
            Main.panel.statusArea.quickSettings.menu.close();
        } else if (!this._toggle.checked && this._pad) {
            this._pad.destroy();
            this._pad = null;
        }
        this._syncRotationVisibility();
    }

    disable() {
        this._pad?.destroy();
        this._pad = null;
        this._settings.disconnect(this._lockId);
        this._monitorManager.disconnect(this._rotationMonitorId);
        this._orientationManager.disconnect(this._rotationSensorId);
        Main.layoutManager.disconnect(this._rotationLayoutId);
        this._toggle.destroy();
        this._rotationToggle.destroy();
        this._indicator.destroy();
        this._toggle = this._indicator = this._settings = null;
        this._preferences = null;
    }
}
