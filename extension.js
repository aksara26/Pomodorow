// Pomodoro Mochi — GNOME Shell 51 (Fedora 45)
// Timer Pomodoro + karakter overlay yang bisa dielus, ngambek saat scrolling, dan bisa dimatikan.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import Character from './character.js';

// ───────────────────────────── Pengaturan ─────────────────────────────
const DEFAULT_DURATIONS = {focus: 25, short: 5, long: 15}; // menit; bisa diubah dari menu
const DURATION_LIMITS = {focus: [5, 120, 5], short: [1, 30, 1], long: [5, 60, 5]}; // [min, maks, langkah]

const CFG = {
    cyclesBeforeLong: 4,
    maxResumeGapSec: 600, // gap maksimum (mis. layar terkunci) yang masih dianggap timer jalan terus
};

const CORNERS = ['br', 'bl', 'tr', 'tl'];
const CORNER_LABEL = {
    br: 'Kanan bawah', bl: 'Kiri bawah', tr: 'Kanan atas', tl: 'Kiri atas',
};
const CHARACTER_SIZES = ['small', 'medium', 'large'];
const CHARACTER_SIZE_LABEL = {small: 'Kecil', medium: 'Sedang', large: 'Besar'};
const CHARACTER_SCALE_STEPS = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

// Eye animation presets
const EYE_SENSITIVITY_PRESETS = ['low', 'normal', 'high'];
const EYE_SENSITIVITY_LABEL = {low: 'Rendah', normal: 'Normal', high: 'Tinggi'};
const BLINK_FREQUENCY_PRESETS = ['low', 'normal', 'high'];
const BLINK_FREQUENCY_LABEL = {low: 'Jarang', normal: 'Normal', high: 'Sering'};
const ANIMATION_SPEED_PRESETS = ['slow', 'normal', 'fast'];
const ANIMATION_SPEED_LABEL = {slow: 'Lambat', normal: 'Normal', fast: 'Cepat'};

const pad2 = n => String(n).padStart(2, '0');

function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtDuration(totalSeconds) {
    const mins = Math.round(totalSeconds / 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h} j ${m} mnt` : `${m} mnt`;
}

// ───────────────────────────── Penyimpanan ─────────────────────────────
class Store {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'pomodoro-mochi']);
        this._path = GLib.build_filenamev([this._dir, 'data.json']);
        this._dirty = false;
        this._saveStatus = 'Sudah tersimpan';
        this._saveStatusHandler = null;
        this.data = {
            settings: {
                characterEnabled: true,
                expressiveMode: true,
                characterSize: 'medium',
                characterScale: 1.0,
                corner: 'br',
                characterPos: null,
                durations: {...DEFAULT_DURATIONS},
                // New settings
                soundEnabled: true,
                soundVolume: 0.5,
                eyeSensitivity: 'normal',
                blinkFrequency: 'normal',
                animationSpeed: 'normal',
                breakSuggestions: true,
                autoStartBreaks: false,
            },
            timer: null,
            days: {},
            reminders: [],
        };
        this._load();
    }

    _load() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._path);
            if (!ok)
                return;
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            this.data.settings = {...this.data.settings, ...(parsed.settings ?? {})};
            if (typeof this.data.settings.expressiveMode !== 'boolean')
                this.data.settings.expressiveMode = true;
            if (!CORNERS.includes(this.data.settings.corner))
                this.data.settings.corner = 'br';
            if (!CHARACTER_SIZES.includes(this.data.settings.characterSize))
                this.data.settings.characterSize = 'medium';
            if (!CHARACTER_SCALE_STEPS.includes(this.data.settings.characterScale))
                this.data.settings.characterScale = 1.0;
            // Validate new settings
            if (!EYE_SENSITIVITY_PRESETS.includes(this.data.settings.eyeSensitivity))
                this.data.settings.eyeSensitivity = 'normal';
            if (!BLINK_FREQUENCY_PRESETS.includes(this.data.settings.blinkFrequency))
                this.data.settings.blinkFrequency = 'normal';
            if (!ANIMATION_SPEED_PRESETS.includes(this.data.settings.animationSpeed))
                this.data.settings.animationSpeed = 'normal';
            if (typeof this.data.settings.soundEnabled !== 'boolean')
                this.data.settings.soundEnabled = true;
            if (typeof this.data.settings.soundVolume !== 'number' || this.data.settings.soundVolume < 0 || this.data.settings.soundVolume > 1)
                this.data.settings.soundVolume = 0.5;
            if (typeof this.data.settings.breakSuggestions !== 'boolean')
                this.data.settings.breakSuggestions = true;
            if (typeof this.data.settings.autoStartBreaks !== 'boolean')
                this.data.settings.autoStartBreaks = false;
            const pos = this.data.settings.characterPos;
            if (pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y)))
                this.data.settings.characterPos = {x: Number(pos.x), y: Number(pos.y)};
            else
                this.data.settings.characterPos = null;
            const d = {...DEFAULT_DURATIONS, ...(parsed.settings?.durations ?? {})};
            for (const key of Object.keys(DEFAULT_DURATIONS)) {
                const [lo, hi] = DURATION_LIMITS[key];
                const v = Math.round(Number(d[key]));
                d[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_DURATIONS[key];
            }
            this.data.settings.durations = d;
            this.data.timer = parsed.timer ?? null;
            this.data.days = parsed.days ?? {};
            this.data.reminders = parsed.reminders ?? [];
        } catch (e) {
            // File belum ada (pertama kali dijalankan) atau rusak: pakai default.
        }
        this._pruneOldDays();
    }

    _pruneOldDays() {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const cutoffKey = dayKey(cutoff);
        for (const key of Object.keys(this.data.days)) {
            if (key < cutoffKey)
                delete this.data.days[key];
        }
    }

    today() {
        const key = dayKey();
        this.data.days[key] ??= {sessions: 0, focusSeconds: 0, pets: 0, sulks: 0, skipped: 0};
        return this.data.days[key];
    }

    dayOrEmpty(key) {
        return this.data.days[key] ?? {sessions: 0, focusSeconds: 0, pets: 0, sulks: 0, skipped: 0};
    }

    getReminders() {
        return this.data.reminders ?? [];
    }

    addReminder(text, intervalHours) {
        const id = Date.now() + Math.floor(Math.random() * 1000);
        this.data.reminders.push({
            id,
            text: text.trim(),
            intervalHours: Math.max(1, Math.round(intervalHours)),
            checkedToday: false,
            lastShown: 0,
            createdAt: Date.now(),
        });
        this.markDirty();
        return id;
    }

    removeReminder(id) {
        this.data.reminders = this.data.reminders.filter(r => r.id !== id);
        this.markDirty();
    }

    toggleReminderChecked(id) {
        const reminder = this.data.reminders.find(r => r.id === id);
        if (reminder) {
            reminder.checkedToday = !reminder.checkedToday;
            this.markDirty();
        }
    }

    updateReminderLastShown(id) {
        const reminder = this.data.reminders.find(r => r.id === id);
        if (reminder) {
            reminder.lastShown = Date.now();
            this.markDirty();
        }
    }

    resetDailyReminders() {
        for (const reminder of this.data.reminders) {
            reminder.checkedToday = false;
            reminder.lastShown = 0;
        }
        this.markDirty();
    }

    markDirty() {
        this._dirty = true;
        this._setSaveStatus('Belum disimpan');
    }

    setSaveStatusHandler(handler) {
        this._saveStatusHandler = handler;
        this._saveStatusHandler?.(this._saveStatus);
    }

    _setSaveStatus(status) {
        if (this._saveStatus === status)
            return;
        this._saveStatus = status;
        this._saveStatusHandler?.(status);
    }

    flushIfDirty() {
        if (this._dirty)
            this.save();
    }

    save() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            GLib.file_set_contents(this._path, new TextEncoder().encode(JSON.stringify(this.data)));
            this._dirty = false;
            this._setSaveStatus('Tersimpan');
            return true;
        } catch (e) {
            console.error(`Pomodoro Mochi: gagal menyimpan data: ${e}`);
            this._setSaveStatus('Gagal simpan');
            return false;
        }
    }

    createBackup() {
        const backupDir = GLib.build_filenamev([this._dir, 'backups']);
        GLib.mkdir_with_parents(backupDir, 0o755);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = GLib.build_filenamev([backupDir, `backup-${timestamp}.json`]);
        GLib.file_set_contents(path, new TextEncoder().encode(JSON.stringify(this.data)));
        return path;
    }

    // Export data as JSON
    exportData() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const exportDir = GLib.build_filenamev([this._dir, 'exports']);
        GLib.mkdir_with_parents(exportDir, 0o755);
        const path = GLib.build_filenamev([exportDir, `pomodoro-export-${timestamp}.json`]);
        const exportData = {
            exportedAt: new Date().toISOString(),
            version: 1,
            settings: this.data.settings,
            days: this.data.days,
            reminders: this.data.reminders,
        };
        GLib.file_set_contents(path, new TextEncoder().encode(JSON.stringify(exportData, null, 2)));
        return path;
    }

    // Export as CSV for spreadsheet
    exportCSV() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const exportDir = GLib.build_filenamev([this._dir, 'exports']);
        GLib.mkdir_with_parents(exportDir, 0o755);
        const path = GLib.build_filenamev([exportDir, `pomodoro-csv-${timestamp}.csv`]);
        
        let csv = 'Tanggal,Sesi Fokus,Waktu Fokus (menit),Elusan,Ngambek,Dilewati\n';
        for (const [date, day] of Object.entries(this.data.days).sort()) {
            const focusMin = Math.round(day.focusSeconds / 60);
            csv += `${date},${day.sessions},${focusMin},${day.pets},${day.sulks},${day.skipped}\n`;
        }
        GLib.file_set_contents(path, new TextEncoder().encode(csv));
        return path;
    }

    // Play notification sound
    playSound(name) {
        if (!this.data.settings.soundEnabled) return;
        try {
            // Use system sounds via canberra-gtk-play or paplay
            const sounds = {
                focusStart: 'bell',
                focusEnd: 'complete',
                breakStart: 'message',
                breakEnd: 'alarm',
                reminder: 'dialog-information',
            };
            const soundName = sounds[name] || 'bell';
            const volume = this.data.settings.soundVolume;
            GLib.spawn_command_line_async(
                `canberra-gtk-play -i ${soundName} -v ${Math.round(volume * 65535)} 2>/dev/null || ` +
                `paplay /usr/share/sounds/freedesktop/stereo/${soundName}.oga --volume=${Math.round(volume * 65535)} 2>/dev/null || true`
            );
        } catch (e) {
            // Silent fail - sound is optional
        }
    }

    // Get break suggestion based on current time and work pattern
    getBreakSuggestion() {
        const now = new Date();
        const hour = now.getHours();
        const today = this.today();
        
        if (hour >= 22 || hour < 6) {
            return {type: 'sleep', text: 'Sudah larut. Istirahat yang cukup biar besok segar!'};
        }
        if (hour >= 12 && hour < 14) {
            return {type: 'lunch', text: 'Waktunya makan siang. Jangan lupa istirahat mata!'};
        }
        if (hour >= 17 && hour < 19) {
            return {type: 'stretch', text: 'Sudah lama duduk. Stretching bentar yuk!'};
        }
        if (today.sessions >= 3 && today.focusSeconds > 7200) { // 3+ sesi, 2+ jam fokus
            return {type: 'long', text: 'Udah banyak fokus hari ini. Istirahat panjang sebentar?'};
        }
        if (today.sessions > 0 && today.focusSeconds > 3600) { // 1+ jam fokus
            return {type: 'short', text: 'Bagus sudah fokus sebentar. Minum air dulu yuk!'};
        }
        return {type: 'normal', text: 'Santai sebentar, tarik napas dalam-dalam.'};
    }
}

// ───────────────────────────── Ekstensi ─────────────────────────────
export default class PomodoroMochiExtension extends Extension {
    enable() {
        this._store = new Store();

        this._phase = 'focus';      // 'focus' | 'short' | 'long'
        this._cycle = 0;            // jumlah sesi fokus selesai dalam putaran ini
        this._running = false;
        this._phaseTotal = this._phaseSeconds('focus');
        this._remaining = this._phaseTotal;
        this._endAt = 0;
        this._lastTick = Date.now();
        this._tickCount = 0;
        this._heartbeatId = null;
        this._stageHandlerId = null;
        this._monitorsHandlerId = null;
        this._menuOpenId = null;
        this._lastDayKey = dayKey(new Date());

        this._buildIndicator();
        this._store.setSaveStatusHandler(status => this._updateSaveStatus(status));
        this._character = new Character(this.path, {
            initialPosition: this._store.data.settings.characterPos,
            size: this._store.data.settings.characterSize,
            scale: this._store.data.settings.characterScale,
            expressiveMode: this._store.data.settings.expressiveMode,
            getCorner: () => this._store.data.settings.corner,
            onSavePosition: pos => {
                this._store.data.settings.characterPos = pos;
                this._store.markDirty();
                this._store.save();
            },
            onPet: () => {
                this._store.today().pets += 1;
                this._store.markDirty();
            },
            onSulk: () => {
                this._store.today().sulks += 1;
                this._store.markDirty();
            },
            onMenu: () => this._indicator?.menu.toggle(),
            getTimerPosition: () => this._timerPosition(),
        });
        this._character.setEnabled(this._store.data.settings.characterEnabled);
        // Apply saved eye/animation settings
        this._character.setEyeSensitivity(this._store.data.settings.eyeSensitivity);
        this._character.setBlinkFrequency(this._store.data.settings.blinkFrequency);
        this._character.setAnimationSpeed(this._store.data.settings.animationSpeed);
        this._restoreTimer();
        this._refresh();
        this._rebuildReminders();

        // Deteksi scrolling di seluruh sesi (event dilihat shell sebelum diteruskan ke jendela).
        this._stageHandlerId = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() === Clutter.EventType.SCROLL)
                this._character.noteScroll();
            return Clutter.EVENT_PROPAGATE;
        });

        this._monitorsHandlerId = Main.layoutManager.connect('monitors-changed', () => {
            this._character.onMonitorsChanged();
        });

        this._heartbeatId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._heartbeatId !== null) {
            GLib.Source.remove(this._heartbeatId);
            this._heartbeatId = null;
        }
        if (this._stageHandlerId !== null) {
            global.stage.disconnect(this._stageHandlerId);
            this._stageHandlerId = null;
        }
        if (this._monitorsHandlerId !== null) {
            Main.layoutManager.disconnect(this._monitorsHandlerId);
            this._monitorsHandlerId = null;
        }

        if (this._store) {
            this._saveTimer();
            this._store.save();
        }

        this._character?.destroy();
        this._character = null;

        this._indicator?.destroy();
        this._indicator = null;
        this._label = null;
        this._statsSection = null;
        this._saveStatusItem = null;
        this._reminderSection = null;
        this._durationLabels = null;
        this._sizeItem = null;
        this._cornerItem = null;
        this._scaleItem = null;
        this._scaleLabel = null;
        this._volumeLabel = null;
        this._eyeSenseItem = null;
        this._blinkFreqItem = null;
        this._animSpeedItem = null;
        this._store = null;
    }

    // ── Timer ──
    _phaseSeconds(phase) {
        return this._store.data.settings.durations[phase] * 60;
    }

    _enterPhase(phase) {
        this._phase = phase;
        this._phaseTotal = this._phaseSeconds(phase);
        this._remaining = this._phaseTotal;
    }

    _started() {
        return this._remaining < this._phaseTotal;
    }

    _toggle() {
        const now = Date.now();
        if (this._running) {
            this._remaining = Math.max(0, Math.ceil((this._endAt - now) / 1000));
            this._running = false;
        } else {
            const fresh = !this._started();
            this._endAt = now + this._remaining * 1000;
            this._lastTick = now;
            this._running = true;
            if (this._phase === 'focus' && fresh) {
                this._character.onFocusStart();
                this._store.playSound('focusStart');
            }
        }
        this._afterStateChange();
    }

    _skip() {
        if (this._phase === 'focus') {
            if (this._started()) {
                this._store.today().skipped += 1;
                this._store.markDirty();
            }
            this._enterPhase('short'); // melewati fokus tidak dihitung sebagai sesi
        } else {
            this._enterPhase('focus');
        }
        this._running = false;
        this._character.onTimerReset();
        this._afterStateChange();
    }

    _reset() {
        this._cycle = 0;
        this._enterPhase('focus');
        this._running = false;
        this._character.onTimerReset();
        this._afterStateChange();
    }

_completePhase() {
        const now = Date.now();
        if (this._phase === 'focus') {
            this._store.today().sessions += 1;
            this._store.markDirty();
            this._cycle += 1;
            const isLong = this._cycle % CFG.cyclesBeforeLong === 0;
            this._enterPhase(isLong ? 'long' : 'short');
            this._endAt = now + this._remaining * 1000;
            this._lastTick = now;
            this._running = true;
            this._store.playSound('focusEnd');
            const d = this._store.data.settings.durations;
            const body = isLong
                ? `Mantap! Istirahat panjang ${d.long} menit ya~`
                : `Mantap! Istirahat ${d.short} menit dulu ya~`;
            Main.notify('Sesi fokus selesai ⏱', body);
            this._character.onFocusComplete(isLong);

            // Show break suggestion if enabled
            if (this._store.data.settings.breakSuggestions && !isLong) {
                const suggestion = this._store.getBreakSuggestion();
                setTimeout(() => {
                    Main.notify('Saran istirahat 💡', suggestion.text);
                }, 2000);
            }
        } else {
            this._enterPhase('focus');
            this._running = false;
            this._store.playSound('breakEnd');
            Main.notify('Istirahat selesai ☕', 'Udah siap? Klik Mulai, aku nemenin~');
            this._character.onBreakComplete();
        }
        this._afterStateChange();
    }

    _tick() {
        const now = Date.now();
        if (this._running) {
            const dt = Math.min((now - this._lastTick) / 1000, 5);
            if (this._phase === 'focus') {
                this._store.today().focusSeconds += dt;
                this._store.markDirty();
            }
            this._remaining = Math.max(0, Math.ceil((this._endAt - now) / 1000));
            if (this._remaining <= 0)
                this._completePhase();
        }
        this._lastTick = now;

        this._character.heartbeat(this._running && this._phase === 'focus');

        this._tickCount += 1;
        if (this._tickCount % 10 === 0)
            this._store.flushIfDirty();
        if (this._indicator.menu.isOpen && this._tickCount % 5 === 0)
            this._rebuildStats();

        this._checkReminders(now);
        this._checkDayChange(now);

        this._refresh();
    }

    _checkDayChange(now) {
        const todayKey = dayKey(new Date(now));
        if (this._lastDayKey !== todayKey) {
            this._lastDayKey = todayKey;
            this._store.resetDailyReminders();
            this._store.save();
            if (this._reminderSection) {
                this._rebuildReminders();
            }
        }
    }

    _checkReminders(now) {
        const reminders = this._store.getReminders();
        for (const reminder of reminders) {
            if (reminder.checkedToday) continue;
            const intervalMs = reminder.intervalHours * 60 * 60 * 1000;
            if (now - reminder.lastShown >= intervalMs) {
                this._showReminder(reminder);
                this._store.updateReminderLastShown(reminder.id);
                this._store.save();
            }
        }
    }

    _showReminder(reminder) {
        if (!this._character || !this._character._enabled) return;

        const isStudying = this._running && this._phase === 'focus';
        let text;
        if (isStudying) {
            const encouragements = [
                `Hei, jangan lupa ${reminder.text.toLowerCase()} ya. Aku jaga kamu! 💪`,
                `Waktunya ${reminder.text.toLowerCase()}, sebentar aja. Semangat! ✨`,
                `Ingetin: ${reminder.text}. Kamu hebat, aku bangga 🌟`,
                `Pengingat: ${reminder.text}. Jangan lupa istirahat sebentar ☕`,
            ];
            text = encouragements[Math.floor(Math.random() * encouragements.length)];
        } else {
            const casual = [
                `Waktunya ${reminder.text.toLowerCase()} nih 🔔`,
                `Hei, jangan lupa ${reminder.text.toLowerCase()} ya. Aku tungguin~`,
                `Pengingat: ${reminder.text}. Yuk, sebentar aja 💪`,
                `Ayo ${reminder.text.toLowerCase()}, nanti aku nemenin terus ⏰`,
            ];
            text = casual[Math.floor(Math.random() * casual.length)];
        }

        this._character.say(text, 6, true);
        this._store.playSound('reminder');
    }

    _afterStateChange() {
        this._saveTimer();
        this._refresh();
        if (this._indicator.menu.isOpen)
            this._rebuildStats();
    }

    _saveTimer() {
        const now = Date.now();
        const remaining = this._running
            ? Math.max(0, Math.ceil((this._endAt - now) / 1000))
            : this._remaining;
        this._store.data.timer = {
            phase: this._phase,
            cycle: this._cycle,
            running: this._running,
            remaining,
            total: this._phaseTotal,
            endAt: this._running ? this._endAt : 0,
            savedAt: now,
        };
        this._store.markDirty();
    }

    // Layar terkunci menonaktifkan ekstensi ini, jadi state timer dipulihkan saat enable().
    _restoreTimer() {
        const t = this._store.data.timer;
        if (!t || !['focus', 'short', 'long'].includes(t.phase))
            return;

        const now = Date.now();
        this._cycle = Number.isFinite(t.cycle) ? t.cycle : 0;
        this._enterPhase(t.phase);
        const full = Number.isFinite(t.total) && t.total > 0 ? Math.round(t.total) : this._phaseTotal;
        this._phaseTotal = full;
        const remainingAtSave = Math.min(Math.max(Math.round(t.remaining ?? full), 0), full);

        if (!t.running) {
            this._remaining = remainingAtSave;
            this._running = false;
            return;
        }

        const gapSec = (now - t.savedAt) / 1000;
        if (!(gapSec >= 0) || gapSec > CFG.maxResumeGapSec) {
            // Terlalu lama tidak aktif (mis. logout): pulihkan dalam keadaan dijeda.
            this._remaining = remainingAtSave;
            this._running = false;
            return;
        }

        if (this._phase === 'focus') {
            const covered = Math.max(0, Math.min(now, t.endAt) - t.savedAt) / 1000;
            this._store.today().focusSeconds += covered;
            this._store.markDirty();
        }

        this._running = true;
        this._endAt = t.endAt;
        this._remaining = Math.max(0, Math.ceil((t.endAt - now) / 1000));
        this._lastTick = now;
        if (this._remaining <= 0)
            this._completePhase();
    }

    // ── UI panel ──
    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
        this._label = new St.Label({text: '◷ 25:00', y_align: Clutter.ActorAlign.CENTER});
        this._indicator.add_child(this._label);

        const menu = this._indicator.menu;

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        menu.addMenuItem(this._statusItem);

        this._saveStatusItem = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        menu.addMenuItem(this._saveStatusItem);

        this._toggleItem = new PopupMenu.PopupMenuItem('Mulai');
        this._toggleItem.connect('activate', () => this._toggle());
        menu.addMenuItem(this._toggleItem);

        const skipItem = new PopupMenu.PopupMenuItem('Lewat fase ini aja');
        skipItem.connect('activate', () => this._skip());
        menu.addMenuItem(skipItem);

        const resetItem = new PopupMenu.PopupMenuItem('Ulang dari awal');
        resetItem.connect('activate', () => this._reset());
        menu.addMenuItem(resetItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const switchItem = new PopupMenu.PopupSwitchMenuItem(
            'Temanin aku', this._store.data.settings.characterEnabled);
        switchItem.connect('toggled', (_item, state) => {
            this._store.data.settings.characterEnabled = state;
            this._store.markDirty();
            this._store.save();
            this._character.setEnabled(state);
        });
        menu.addMenuItem(switchItem);

        const expressiveItem = new PopupMenu.PopupSwitchMenuItem(
            'Mode ekspresif', this._store.data.settings.expressiveMode !== false);
        expressiveItem.connect('toggled', (_item, state) => {
            this._store.data.settings.expressiveMode = state;
            this._store.markDirty();
            this._store.save();
            this._character.setExpressiveMode(state);
        });
        menu.addMenuItem(expressiveItem);

        this._cornerItem = new PopupMenu.PopupMenuItem('');
        this._updateCornerLabel();
        this._cornerItem.connect('activate', () => {
            const s = this._store.data.settings;
            s.corner = CORNERS[(CORNERS.indexOf(s.corner) + 1) % CORNERS.length];
            s.characterPos = null;
            this._store.markDirty();
            this._store.save();
            this._updateCornerLabel();
            this._character.resetPosition();
        });
        menu.addMenuItem(this._cornerItem);

        this._sizeItem = new PopupMenu.PopupMenuItem('');
        this._updateSizeLabel();
        this._sizeItem.connect('activate', () => {
            const s = this._store.data.settings;
            s.characterSize = CHARACTER_SIZES[
                (CHARACTER_SIZES.indexOf(s.characterSize) + 1) % CHARACTER_SIZES.length];
            this._store.markDirty();
            this._store.save();
            this._character.setSize(s.characterSize);
            this._updateSizeLabel();
        });
        menu.addMenuItem(this._sizeItem);

        this._scaleItem = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        this._scaleLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 3em; text-align: center;',
        });
        this._updateScaleLabel();
        const scaleMinus = new St.Button({
            label: '−', style_class: 'button', can_focus: true,
            accessible_name: 'Kecilkan skala karakter',
            style: 'padding: 2px 12px;',
        });
        const scalePlus = new St.Button({
            label: '+', style_class: 'button', can_focus: true,
            accessible_name: 'Besarkan skala karakter',
            style: 'padding: 2px 12px;',
        });
        scaleMinus.connect('clicked', () => this._changeScale(-1));
        scalePlus.connect('clicked', () => this._changeScale(1));
        this._scaleItem.add_child(new St.Label({text: 'Skala', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._scaleItem.add_child(scaleMinus);
        this._scaleItem.add_child(this._scaleLabel);
        this._scaleItem.add_child(scalePlus);
        menu.addMenuItem(this._scaleItem);

        const resetPosItem = new PopupMenu.PopupMenuItem('Balikin posisi awal');
        resetPosItem.connect('activate', () => {
            this._store.data.settings.characterPos = null;
            this._store.markDirty();
            this._store.save();
            this._character.resetPosition();
        });
        menu.addMenuItem(resetPosItem);

        const backupItem = new PopupMenu.PopupMenuItem('Simpan cadangan');
        backupItem.connect('activate', () => {
            this._saveTimer();
            if (!this._store.save()) {
                Main.notify('Cadangan gagal', 'Data belum tersimpan.');
                return;
            }
            try {
                const path = this._store.createBackup();
                Main.notify('Cadangan tersimpan', `Di ${path}`);
            } catch (e) {
                console.error(`Pomodoro Mochi: gagal membuat cadangan: ${e}`);
                Main.notify('Cadangan gagal', 'Gagal menulis file cadangan.');
            }
        });
        menu.addMenuItem(backupItem);

        // Export data
        const exportJsonItem = new PopupMenu.PopupMenuItem('Ekspor data (JSON)');
        exportJsonItem.connect('activate', () => {
            try {
                const path = this._store.exportData();
                Main.notify('Ekspor JSON', `Tersimpan di ${path}`);
            } catch (e) {
                Main.notify('Ekspor gagal', 'Gagal menulis file JSON.');
            }
        });
        menu.addMenuItem(exportJsonItem);

        const exportCsvItem = new PopupMenu.PopupMenuItem('Ekspor CSV (spreadsheet)');
        exportCsvItem.connect('activate', () => {
            try {
                const path = this._store.exportCSV();
                Main.notify('Ekspor CSV', `Tersimpan di ${path}`);
            } catch (e) {
                Main.notify('Ekspor gagal', 'Gagal menulis file CSV.');
            }
        });
        menu.addMenuItem(exportCsvItem);

        // Sound settings
        const soundItem = new PopupMenu.PopupSwitchMenuItem(
            'Suara notifikasi', this._store.data.settings.soundEnabled);
        soundItem.connect('toggled', (_item, state) => {
            this._store.data.settings.soundEnabled = state;
            this._store.markDirty();
            this._store.save();
        });
        menu.addMenuItem(soundItem);

        const volumeItem = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        this._volumeLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 3em; text-align: center;',
        });
        this._updateVolumeLabel();
        const volMinus = new St.Button({
            label: '−', style_class: 'button', can_focus: true,
            accessible_name: 'Kurangi volume',
            style: 'padding: 2px 12px;',
        });
        const volPlus = new St.Button({
            label: '+', style_class: 'button', can_focus: true,
            accessible_name: 'Tambah volume',
            style: 'padding: 2px 12px;',
        });
        volMinus.connect('clicked', () => this._changeVolume(-0.1));
        volPlus.connect('clicked', () => this._changeVolume(0.1));
        volumeItem.add_child(new St.Label({text: 'Volume', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        volumeItem.add_child(volMinus);
        volumeItem.add_child(this._volumeLabel);
        volumeItem.add_child(volPlus);
        menu.addMenuItem(volumeItem);

        // Eye settings
        this._eyeSenseItem = new PopupMenu.PopupMenuItem('');
        this._updateEyeSenseLabel();
        this._eyeSenseItem.connect('activate', () => {
            const s = this._store.data.settings;
            const idx = EYE_SENSITIVITY_PRESETS.indexOf(s.eyeSensitivity);
            s.eyeSensitivity = EYE_SENSITIVITY_PRESETS[(idx + 1) % EYE_SENSITIVITY_PRESETS.length];
            this._store.markDirty();
            this._store.save();
            this._updateEyeSenseLabel();
            this._character.setEyeSensitivity?.(s.eyeSensitivity);
        });
        menu.addMenuItem(this._eyeSenseItem);

        this._blinkFreqItem = new PopupMenu.PopupMenuItem('');
        this._updateBlinkFreqLabel();
        this._blinkFreqItem.connect('activate', () => {
            const s = this._store.data.settings;
            const idx = BLINK_FREQUENCY_PRESETS.indexOf(s.blinkFrequency);
            s.blinkFrequency = BLINK_FREQUENCY_PRESETS[(idx + 1) % BLINK_FREQUENCY_PRESETS.length];
            this._store.markDirty();
            this._store.save();
            this._updateBlinkFreqLabel();
            this._character.setBlinkFrequency?.(s.blinkFrequency);
        });
        menu.addMenuItem(this._blinkFreqItem);

        this._animSpeedItem = new PopupMenu.PopupMenuItem('');
        this._updateAnimSpeedLabel();
        this._animSpeedItem.connect('activate', () => {
            const s = this._store.data.settings;
            const idx = ANIMATION_SPEED_PRESETS.indexOf(s.animationSpeed);
            s.animationSpeed = ANIMATION_SPEED_PRESETS[(idx + 1) % ANIMATION_SPEED_PRESETS.length];
            this._store.markDirty();
            this._store.save();
            this._updateAnimSpeedLabel();
            this._character.setAnimationSpeed?.(s.animationSpeed);
        });
        menu.addMenuItem(this._animSpeedItem);

        // Break suggestions
        const breakSuggestItem = new PopupMenu.PopupSwitchMenuItem(
            'Saran istirahat', this._store.data.settings.breakSuggestions);
        breakSuggestItem.connect('toggled', (_item, state) => {
            this._store.data.settings.breakSuggestions = state;
            this._store.markDirty();
            this._store.save();
        });
        menu.addMenuItem(breakSuggestItem);

        const autoBreakItem = new PopupMenu.PopupSwitchMenuItem(
            'Auto mulai istirahat', this._store.data.settings.autoStartBreaks);
        autoBreakItem.connect('toggled', (_item, state) => {
            this._store.data.settings.autoStartBreaks = state;
            this._store.markDirty();
            this._store.save();
        });
        menu.addMenuItem(autoBreakItem);

        // ── Reminder section ──────────────────────────────────────────
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('📝 Pengingat Harian'));
        this._reminderSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._reminderSection);
        this._buildReminderInput();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Durasi (menit)'));
        this._durationLabels = {};
        this._addStepper(menu, 'Fokus', 'focus');
        this._addStepper(menu, 'Istirahat pendek', 'short');
        this._addStepper(menu, 'Istirahat panjang', 'long');

        this._statsSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._statsSection);
        this._rebuildStats();

        this._menuOpenId = menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._rebuildStats();
                this._rebuildReminders();
            }
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    _addStepper(menu, title, key) {
        const [min, max, step] = DURATION_LIMITS[key];
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        item.add_child(new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));

        const minus = new St.Button({
            label: '−', style_class: 'button', can_focus: true,
            accessible_name: `Kurangi ${title}`,
            style: 'padding: 2px 12px;',
        });
        const value = new St.Label({
            text: `${this._store.data.settings.durations[key]}`,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 3em; text-align: center;',
        });
        const plus = new St.Button({
            label: '+', style_class: 'button', can_focus: true,
            accessible_name: `Tambah ${title}`,
            style: 'padding: 2px 12px;',
        });
        minus.connect('clicked', () => this._changeDuration(key, -step, min, max));
        plus.connect('clicked', () => this._changeDuration(key, step, min, max));

        item.add_child(minus);
        item.add_child(value);
        item.add_child(plus);
        this._durationLabels[key] = value;
        menu.addMenuItem(item);
    }

    _changeDuration(key, delta, min, max) {
        const d = this._store.data.settings.durations;
        d[key] = Math.min(max, Math.max(min, d[key] + delta));
        this._durationLabels[key].text = `${d[key]}`;
        this._store.markDirty();
        this._store.save();

        // Fase yang belum dimulai langsung memakai durasi baru; yang sudah berjalan tidak diubah.
        if (key === this._phase && !this._started()) {
            this._phaseTotal = this._phaseSeconds(this._phase);
            this._remaining = this._phaseTotal;
            if (this._running)
                this._endAt = Date.now() + this._remaining * 1000;
            this._saveTimer();
        }
        this._refresh();
    }

    _updateCornerLabel() {
        this._cornerItem.label.text = `Posisi: ${CORNER_LABEL[this._store.data.settings.corner]} (seret buat pindah)`;
    }

    _updateSizeLabel() {
        this._sizeItem.label.text = `Ukuran: ${CHARACTER_SIZE_LABEL[this._store.data.settings.characterSize]}`;
    }

    _updateScaleLabel() {
        const scale = this._store.data.settings.characterScale;
        this._scaleLabel.text = `${Math.round(scale * 100)}%`;
    }

    _updateSaveStatus(status) {
        if (this._saveStatusItem)
            this._saveStatusItem.label.text = `Penyimpanan: ${status}`;
    }

    _changeScale(delta) {
        const s = this._store.data.settings;
        const idx = CHARACTER_SCALE_STEPS.indexOf(s.characterScale);
        const newIdx = Math.max(0, Math.min(CHARACTER_SCALE_STEPS.length - 1, idx + delta));
        s.characterScale = CHARACTER_SCALE_STEPS[newIdx];
        this._store.markDirty();
        this._store.save();
        this._character.setScale(s.characterScale);
        this._updateScaleLabel();
    }

    _updateVolumeLabel() {
        const vol = this._store.data.settings.soundVolume;
        this._volumeLabel.text = `${Math.round(vol * 100)}%`;
    }

    _changeVolume(delta) {
        const s = this._store.data.settings;
        s.soundVolume = Math.max(0, Math.min(1, Math.round((s.soundVolume + delta) * 10) / 10));
        this._store.markDirty();
        this._store.save();
        this._updateVolumeLabel();
    }

    _updateEyeSenseLabel() {
        this._eyeSenseItem.label.text = `Sensitivitas mata: ${EYE_SENSITIVITY_LABEL[this._store.data.settings.eyeSensitivity]}`;
    }

    _updateBlinkFreqLabel() {
        this._blinkFreqItem.label.text = `Frekuensi kedip: ${BLINK_FREQUENCY_LABEL[this._store.data.settings.blinkFrequency]}`;
    }

    _updateAnimSpeedLabel() {
        this._animSpeedItem.label.text = `Kecepatan animasi: ${ANIMATION_SPEED_LABEL[this._store.data.settings.animationSpeed]}`;
    }

    _buildReminderInput() {
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        item.add_child(new St.Label({text: 'Tambah pengingat', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));

        const entry = new St.Entry({
            hint_text: 'Contoh: minum air',
            can_focus: true,
            accessible_name: 'Teks pengingat',
            style: 'min-width: 180px; margin-right: 8px;',
        });
        entry.clutter_text.connect('activate', () => this._addReminderFromEntry(entry));

        const intervalBox = new St.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL, style: 'spacing: 4px;'});
        intervalBox.add_child(new St.Label({text: 'Tiap', y_align: Clutter.ActorAlign.CENTER}));
        const intervalEntry = new St.Entry({
            hint_text: 'jam',
            can_focus: true,
            accessible_name: 'Interval pengingat (jam)',
            style: 'min-width: 40px; text-align: center;',
        });
        intervalEntry.clutter_text.connect('activate', () => this._addReminderFromEntry(entry, intervalEntry));
        intervalBox.add_child(intervalEntry);
        intervalBox.add_child(new St.Label({text: 'jam', y_align: Clutter.ActorAlign.CENTER}));

        const addBtn = new St.Button({label: 'Tambah', style_class: 'button', can_focus: true, style: 'padding: 2px 12px;'});
        addBtn.connect('clicked', () => this._addReminderFromEntry(entry, intervalEntry));

        item.add_child(entry);
        item.add_child(intervalBox);
        item.add_child(addBtn);
        this._reminderSection.addMenuItem(item);
    }

    _addReminderFromEntry(entry, intervalEntry) {
        const text = entry.get_text().trim();
        if (!text) return;
        let interval = 1;
        if (intervalEntry) {
            const val = parseInt(intervalEntry.get_text().trim(), 10);
            if (!isNaN(val) && val > 0) interval = val;
        }
        this._store.addReminder(text, interval);
        this._store.save();
        entry.set_text('');
        if (intervalEntry) intervalEntry.set_text('');
        this._rebuildReminders();
    }

    _rebuildReminders() {
        if (!this._reminderSection) return;

        this._reminderSection.removeAll();
        const reminders = this._store.getReminders();
        if (reminders.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem('Belum ada pengingat. Tambah di atas.', {reactive: false, can_focus: false});
            this._reminderSection.addMenuItem(emptyItem);
            return;
        }

        for (const reminder of reminders) {
            const item = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 4px; padding: 4px 0;'});

            const textLabel = new St.Label({
                text: reminder.text,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style: 'font-weight: bold;',
            });
            box.add_child(textLabel);

            const metaBox = new St.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL, style: 'spacing: 8px;'});
            const intervalLabel = new St.Label({
                text: `🔁 Tiap ${reminder.intervalHours} jam`,
                style: 'color: #888; font-size: 9pt;',
            });
            metaBox.add_child(intervalLabel);

            const checkBtn = new St.Button({
                label: reminder.checkedToday ? '✓ Selesai' : '☐ Belum',
                style_class: reminder.checkedToday ? 'button' : 'button',
                can_focus: true,
                accessible_name: reminder.checkedToday
                    ? `Tandai pengingat ${reminder.text} belum selesai`
                    : `Tandai pengingat ${reminder.text} sudah selesai`,
                style: 'padding: 2px 8px;',
            });
            checkBtn.connect('clicked', () => {
                this._store.toggleReminderChecked(reminder.id);
                this._store.save();
                this._rebuildReminders();
            });
            metaBox.add_child(checkBtn);

            const delBtn = new St.Button({
                label: '🗑 Hapus',
                style_class: 'button',
                can_focus: true,
                accessible_name: `Hapus pengingat ${reminder.text}`,
                style: 'padding: 2px 8px;',
            });
            delBtn.connect('clicked', () => {
                this._store.removeReminder(reminder.id);
                this._store.save();
                this._rebuildReminders();
            });
            metaBox.add_child(delBtn);

            box.add_child(metaBox);
            item.add_child(box);
            this._reminderSection.addMenuItem(item);
        }
    }

    _rebuildStats() {
        if (!this._statsSection)
            return;
        this._statsSection.removeAll();

        const add = text => this._statsSection.addMenuItem(
            new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false}));

        const t = this._store.today();
        this._statsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Statistik hari ini'));
        add(`◷ Sesi fokus: ${t.sessions}`);
        add(`⏱ Waktu fokus: ${fmtDuration(t.focusSeconds)}`);
        add(`💙 Elusan: ${t.pets}`);
        add(`💢 Ngambek: ${t.sulks}x`);
        add(`⏭ Dilewatin: ${t.skipped}`);

        this._statsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('7 hari terakhir'));
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const day = this._store.dayOrEmpty(dayKey(d));
            add(`${DAY_NAMES[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}: ` +
                `${day.sessions} sesi · ${fmtDuration(day.focusSeconds)}`);
        }
    }

    _timerPosition() {
        if (!this._label)
            return null;
        try {
            const [x, y] = this._label.get_transformed_position();
            return [x + this._label.width / 2, y + this._label.height / 2];
        } catch (e) {
            return null;
        }
    }

    _refresh() {
        const rem = this._remaining;
        const time = `${pad2(Math.floor(rem / 60))}:${pad2(rem % 60)}`;
        let icon = this._phase === 'focus' ? '◷' : '☕';
        if (!this._running && this._started())
            icon = '⏸';
        this._label.text = `${icon} ${time}`;

        const phaseName = this._phase === 'focus'
            ? `Fokus — sesi ${this._cycle % CFG.cyclesBeforeLong + 1}/${CFG.cyclesBeforeLong}`
            : this._phase === 'short' ? 'Istirahat pendek' : 'Istirahat panjang';
        const state = this._running ? 'jalan' : this._started() ? 'pause' : 'siap';
        this._label.accessible_name = `${phaseName}, ${state}, sisa ${Math.floor(rem / 60)} menit ${rem % 60} detik`;
        this._statusItem.label.text = `${phaseName} (${state})`;
        this._toggleItem.label.text = this._running ? 'Jeda' : this._started() ? 'Lanjut' : 'Mulai';
        this._character?.setTimer(this._phase, this._running, this._remaining);
    }
}
