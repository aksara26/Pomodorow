// Karakter overlay Pomodoro Mochi.
//
// Renderer: layered 2D (head/body/iris/eyelid/mouth/blush/hearts) built from
// the original portrait by tools/build_character_assets.py. The original PNGs
// are kept untouched; images/character/ adds the transparent animation layers.
//
// The character is intentionally isolated from the Pomodoro UI: it only reads
// timer state and writes its own actor transforms. No app-wide re-render.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SOURCE = 400; // the animation layers are 400x400 source pixels
const SIZES = {
    small: 200,
    medium: 230,
    large: 280,
};
const SIZE_ORDER = ['small', 'medium', 'large'];
const SIZE_LABEL = {small: 'Kecil', medium: 'Sedang', large: 'Besar'};
const DEFAULT_SIZE = 'medium';
const MIN_SCALE = 0.6;
const MAX_SCALE = 1.6;
const DEFAULT_SCALE = 1.0;
const STAGE = {X: 5, Y: 78, PAD_X: 10, PAD_Y: 80, MARGIN: 16};
const TICK_MS = 33;
const REDUCED_TICK_MS = 100;

// Eye travel is derived from the generated face geometry: how far an iris can
// slide before it would poke out of the socket. Source pixels, see EYES in
// tools/build_character_assets.py. Screen travel scales with the display size.
// Sockets are scaled by EYE_SCALE there; iris radius is 8.3 x 6.7.
const EYE_GEO = {
    travelX: 3.9,
    travelY: 1.7,
    pivotLeft: [197.5 / 400, 96.0 / 400],   // [0.49375, 0.24]
    pivotRight: [249.5 / 400, 109.5 / 400], // [0.62375, 0.27375]
};

// Per-state feel. This is what makes "belajar" and "istirahat" look and move
// differently instead of only swapping a mouth sprite.
const STYLE_DEFAULT = {
    breath: 3.6, sway: 0.35, blink: [2600, 6200], talk: 1,
    lean: 0, lift: 0, biasX: 0, biasY: 0, saccade: [2600, 6200], drift: 0.45,
};
const STATE_STYLE = {
    studying: {
        breath: 3.8, sway: 0.12, blink: [5000, 9000], talk: 1.5,
        lean: 1.0, lift: 1.5, biasX: 0, biasY: 0.6, saccade: [1500, 3000], drift: 0.08,
    },
    resting: {
        breath: 6.0, sway: 0.8, blink: [2000, 4000], talk: 0.5,
        lean: -0.8, lift: 0.3, biasX: 0.3, biasY: -0.1, saccade: [4000, 8000], drift: 0.8,
    },
    sleepy: {
        breath: 7.0, sway: 0.2, blink: [5000, 9000], talk: 0.7,
        lean: 1.5, lift: 1.8, biasX: 0, biasY: 0.3, saccade: [5000, 10000], drift: 0.15,
    },
    bored: {
        breath: 4.8, sway: 0.35, blink: [3500, 7000], talk: 0.85,
        lean: 0.8, lift: 1.0, biasX: -0.4, biasY: 0.15, saccade: [4000, 8000], drift: 0.35,
    },
    ignored: {
        breath: 3.0, sway: 0.15, blink: [2000, 4000], talk: 1.2,
        lean: -1.2, lift: 0.5, biasX: -0.5, biasY: -0.2, saccade: [1500, 3000], drift: 0.1,
    },
    grumpy: {
        breath: 3.5, sway: 0.2, blink: [3000, 5000], talk: 1.0,
        lean: -1.0, lift: 0.8, biasX: -0.4, biasY: 0, saccade: [2000, 4000], drift: 0.2,
    },
};
const styleFor = state => {
    const base = STATE_STYLE[state] ?? STYLE_DEFAULT;
    // Apply instance multipliers if available
    if (typeof styleFor._blinkMult === 'number' && base.blink) {
        return {
            ...base,
            blink: [Math.round(base.blink[0] * styleFor._blinkMult), Math.round(base.blink[1] * styleFor._blinkMult)],
        };
    }
    if (typeof styleFor._animMult === 'number') {
        return {
            ...base,
            breath: base.breath / styleFor._animMult,
            sway: base.sway * styleFor._animMult,
            saccade: base.saccade ? [Math.round(base.saccade[0] / styleFor._animMult), Math.round(base.saccade[1] / styleFor._animMult)] : base.saccade,
        };
    }
    return base;
};

// Blink frames: [duration ms, lid state]. More frames = smoother animation.
// Each frame: [ms, lid_state] where lid_state can be 'open', 'quarter', 'half', 'three-quarter', 'closed', 'happy'
const BLINK_FRAMES = {
    // Standard natural blink: ~150-200ms total
    normal: [[38, 'quarter'], [42, 'half'], [48, 'three-quarter'], [58, 'closed'], [42, 'three-quarter'], [38, 'half'], [30, 'quarter'], [24, 'open']],
    // Soft blink for relaxed/sleepy states - slower, more gentle
    soft: [[60, 'quarter'], [70, 'half'], [80, 'three-quarter'], [100, 'closed'], [80, 'three-quarter'], [70, 'half'], [60, 'quarter'], [50, 'open']],
    // Fast blink for alert/focused states
    fast: [[20, 'quarter'], [25, 'half'], [30, 'closed'], [25, 'half'], [20, 'quarter'], [15, 'open']],
    // Slow deliberate blink (thinking, bored)
    slow: [[80, 'quarter'], [100, 'half'], [120, 'three-quarter'], [150, 'closed'], [120, 'three-quarter'], [100, 'half'], [80, 'quarter'], [60, 'open']],
    // Surprised/startled - quick close, slow open
    startled: [[15, 'half'], [20, 'closed'], [80, 'three-quarter'], [100, 'half'], [80, 'quarter'], [60, 'open']],
    // Flirtatious/playful - half blink with pause
    playful: [[35, 'quarter'], [40, 'half'], [45, 'three-quarter'], [80, 'closed'], [120, 'three-quarter'], [40, 'half'], [35, 'quarter'], [30, 'open']],
    // Dreamy - very slow, heavy lids
    dreamy: [[100, 'quarter'], [120, 'half'], [150, 'three-quarter'], [200, 'closed'], [150, 'three-quarter'], [120, 'half'], [100, 'quarter'], [80, 'open']],
    // Suspicious - asymmetric, one eye more closed
    suspicious: [[40, 'quarter'], [50, 'half'], [60, 'three-quarter'], [40, 'quarter'], [30, 'open']],
    // Tired - slow close, very slow open (struggling)
    tired: [[70, 'quarter'], [90, 'half'], [110, 'three-quarter'], [180, 'closed'], [200, 'three-quarter'], [150, 'half'], [100, 'quarter'], [80, 'open']],
    // Wink - one eye only (handled specially)
    wink: [[30, 'quarter'], [35, 'half'], [40, 'closed'], [35, 'half'], [30, 'quarter'], [20, 'open']],
    // Micro-blink - barely noticeable, for focus
    micro: [[15, 'quarter'], [20, 'half'], [15, 'quarter'], [10, 'open']],
};

// Eye behavior configs per state - controls pupil, gaze, blink style
const EYE_BEHAVIOR = {
    studying: { pupilBase: 0.97, pupilRange: 0.08, saccadeSpeed: 1.2, blinkStyle: 'micro', squint: 0.15 },
    resting: { pupilBase: 1.0, pupilRange: 0.12, saccadeSpeed: 0.8, blinkStyle: 'soft', squint: 0 },
    sleepy: { pupilBase: 0.9, pupilRange: 0.05, saccadeSpeed: 0.5, blinkStyle: 'dreamy', squint: 0.3 },
    sleeping: { pupilBase: 0.8, pupilRange: 0.02, saccadeSpeed: 0.2, blinkStyle: 'dreamy', squint: 0.5 },
    bored: { pupilBase: 0.94, pupilRange: 0.06, saccadeSpeed: 0.7, blinkStyle: 'slow', squint: 0.1 },
    grumpy: { pupilBase: 0.94, pupilRange: 0.04, saccadeSpeed: 1.0, blinkStyle: 'slow', squint: 0.25 },
    ignored: { pupilBase: 0.92, pupilRange: 0.03, saccadeSpeed: 0.6, blinkStyle: 'tired', squint: 0.2 },
    happy: { pupilBase: 1.05, pupilRange: 0.1, saccadeSpeed: 1.1, blinkStyle: 'playful', squint: 0 },
    excited: { pupilBase: 1.07, pupilRange: 0.15, saccadeSpeed: 1.3, blinkStyle: 'playful', squint: 0 },
    curious: { pupilBase: 1.02, pupilRange: 0.1, saccadeSpeed: 1.0, blinkStyle: 'normal', squint: 0 },
    focused: { pupilBase: 0.97, pupilRange: 0.05, saccadeSpeed: 1.3, blinkStyle: 'micro', squint: 0.2 },
    thinking: { pupilBase: 0.98, pupilRange: 0.08, saccadeSpeed: 0.7, blinkStyle: 'slow', squint: 0.15 },
    suspicious: { pupilBase: 0.95, pupilRange: 0.05, saccadeSpeed: 0.9, blinkStyle: 'suspicious', squint: 0.35 },
    idle: { pupilBase: 1.0, pupilRange: 0.1, saccadeSpeed: 1.0, blinkStyle: 'normal', squint: 0 },
};

const dragSlopFor = display => Math.max(8, Math.round(display * 0.048));
const PET_DISTANCE = 220;
const PET_WINDOW_MS = 1500;
const PET_COOLDOWN_MS = 2000;

// Doom scroll blocker: trigger after this many scroll seconds in 60s window
const DOOM_SCROLL_THRESHOLD = 8;      // detik scroll dalam 60 detik -> trigger blocker
const DOOM_SCROLL_WINDOW = 60;        // window detik
const DOOM_BLOCKER_COOLDOWN = 120000; // cooldown 2 menit sebelum bisa trigger lagi
const DOOM_BLOCKER_DURATION = 15000;  // blocker tampil max 15 detik kalau gak di-dismiss
const SULK_FORGIVE_DELAY_SEC = 60;

const PRIORITY = {
    micro: 1,
    context: 2,
    drag: 3,
    interaction: 4,
    celebration: 5,
};

// All 16 expressions. Visual changes are real layers: eye/pupil, eyelid,
// mouth, blush, hearts, head tilt.
const EXPRESSIONS = {
    neutral: {mouth: 'neutral', lid: 'open', head: 0, blush: 0, hearts: false},
    happy: {mouth: 'smile', lid: 'open', head: 1.2, blush: 0.55, hearts: false},
    excited: {mouth: 'open', lid: 'open', head: -1.2, blush: 0.8, hearts: true},
    focused: {mouth: 'determined', lid: 'half', head: 1.2, blush: 0, gazeY: 0.55},
    curious: {mouth: 'o', lid: 'open', head: 3, blush: 0.15, gazeX: 0.55},
    sleepy: {mouth: 'yawn', lid: 'half', head: 2.4, blush: 0.25, gazeY: 0.35},
    sleeping: {mouth: 'neutral', lid: 'closed', head: 2.8, blush: 0.2, gazeY: 0.5},
    bored: {mouth: 'pout', lid: 'half', head: 3.4, blush: 0, gazeX: -0.65},
    grumpy: {mouth: 'frown', lid: 'half', head: -2.2, blush: 0, brow: 'angry', gazeX: -0.4},
    surprised: {mouth: 'o', lid: 'open', head: -3, blush: 0.35, gazeY: -0.2},
    proud: {mouth: 'smile', lid: 'half', head: 2, blush: 0.65, hearts: true},
    laughing: {mouth: 'laugh', lid: 'happy', head: 2, blush: 0.8, hearts: true},
    thinking: {mouth: 'smirk', lid: 'half', head: -2, blush: 0.1, gazeX: -0.5, gazeY: -0.55},
    relaxed: {mouth: 'smile', lid: 'half', head: 1, blush: 0.3},
    confused: {mouth: 'frown', lid: 'open', head: 4, blush: 0.1, brow: 'confused', gazeX: 0.5, gazeY: -0.2},
    smiling: {mouth: 'smile', lid: 'open', head: 1, blush: 0.35},
    determined: {mouth: 'determined', lid: 'open', head: -1, blush: 0, gazeY: 0.15},
    shy: {mouth: 'smile', lid: 'happy', head: 3, blush: 1, brow: 'shy', gazeX: -0.35, gazeY: 0.25, hearts: true},
    adore: {mouth: 'laugh', lid: 'happy', head: 1, blush: 1, gazeY: -0.15, hearts: true},
    pouting: {mouth: 'pout', lid: 'quarter', head: -2, blush: 0.15, gazeX: -0.55},
};

const STATE_EXPRESSION = {
    idle: 'neutral',
    curious: 'curious',
    studying: 'focused',
    resting: 'relaxed',
    bored: 'bored',
    sleepy: 'sleepy',
    sleeping: 'sleeping',
    grumpy: 'grumpy',
    ignored: 'grumpy',
    happy: 'happy',
    excited: 'excited',
    thinking: 'thinking',
    celebrating: 'excited',
    clicked: 'happy',
    dragged: 'surprised',
    interaction: 'smiling',
};

// Dialog pools are intentionally separate from behaviour so they are easy to
// edit/extend. No guilt-tripping or learning pressure.
const DIALOGUE = {
    focusStart: [
        'Yuk, fokus bareng aku.',
        'Mulai dulu, aku nemenin di sini.',
        'Fokus sebentar, habis itu istirahat bareng.',
        'Siap? Kita kerjain bareng ya.',
    ],
    studying: [
        'Semangat, sebentar lagi.',
        'Aku ikut serius sama kamu.',
        'Pelan-pelan aja, kamu pasti bisa.',
        'Kamu hebat, aku bangga.',
        'Aku nemenin kamu terus.',
        'Fokus dulu, nanti istirahat bareng.',
        'Jangan lelah sendirian, aku di sini.',
        'Bagus, lanjut dikit lagi.',
    ],
    focusNearEnd: [
        'Dikit lagi, kamu pasti kuat.',
        'Hampir selesai, aku tunggu kamu.',
        'Tahan bentar lagi.',
        'Yeay, sebentar lagi kamu menang.',
    ],
    breakStart: [
        'Istirahat dulu, aku siapin pelukan.',
        'Badan dilurusin bentar.',
        'Minum dulu, nanti aku cek.',
        'Recharge dulu, aku nemenin.',
        'Santai sebentar, kamu hebat.',
        'Waktunya istirahat.',
    ],
    breakIdle: [
        'Istirahat dulu, aku kangen.',
        'Jangan lupa minum, biar aku tenang.',
        'Stretching bentar, yuk. Aku ikut lihat.',
        'Recharge dulu, nanti lanjut bareng.',
        'Santai aja, aku tetap di sini.',
    ],
    breakEnd: [
        'Istirahat habis, tapi aku masih mau bareng kamu.',
        'Ayo lanjut pelan-pelan.',
        'Udah terisi? Kita mulai.',
        'Klik Mulai kalau udah siap. Aku tunggu.',
    ],
    idle: [
        'Hmm, lagi ngapain?',
        'Aku nungguin kamu nih.',
        'Pssst, aku di sini loh.',
        'Hai, lihat aku sebentar.',
        'Mau mulai kapan? Aku siap nemenin.',
        'Aku diam aja sambil lihat kamu.',
        'Tap aku ya, aku kangen.',
    ],
    bored: [
        'Hmm... aku bosan kalau tanpa kamu.',
        'Ayo mulai sesuatu bareng aku.',
        'Aku nunggu kamu terus.',
    ],
    sleepy: [
        'Ngantuk dikit... tapi aku nemenin kamu.',
        'Hmm... *yawn* jangan sendirian.',
        'Jangan lupa istirahat.',
    ],
    sleeping: [
        'Zzz... 💤',
        '...nyenyak... 😴',
        'Mimpi indah... ✨',
        'Zzz... aku di sini kok...',
    ],
    click: [
        'Eh? Hehe.',
        'Ada apa?',
        'Hihi, geli.',
        'Kamu manggil aku?',
        'Wah, aku senang.',
    ],
    doubleClick: [
        'Wah, dua kali! Aku makin senang.',
        'Aku di sini kok, dekat kamu.',
        'Hihi, kamu manja juga ya?',
    ],
    dragEnd: [
        'Di sini ya? Aku duduk manis di sini.',
        'Nyaman banget nih posisinya.',
        'Hehe, tempat baru buat aku lihat kamu.',
    ],
    pet: [
        'Hehe, geli tapi aku suka.',
        'Nyaman... jangan berhenti.',
        'Makasih sudah elus aku.',
        'Mmm~ aku manja sama kamu.',
        'Jangan berhenti, aku malu tapi senang.',
        'Dielus terus bikin aku jatuh cinta.',
        'Pelan-pelan, aku mau nikmatin.',
    ],
    shy: [
        'EH?! Apaan sih! Jangan bikin aku salting gitu dong!',
        'Ihh... kok kamu tiba-tiba baik banget?!',
        'H-hah?! Aku? Seneng? Nggak kok! ...ya, dikit.',
        'Aduhh, jangan dipuji terus! Aku bingung mau ngomong apa!',
        'Hih... ih, jangan liatin aku gitu dong, malu!',
        'B-bukan berarti aku seneng kamu dengerin, ya! Tapi... makasih.',
        'Yaaa ampun! Kok aku jadi senyum sendiri?!',
        'IHHH! Udah, jangan bahas itu lagi! Maluu!',
        'Hehe... eh! Kok ketawa?! Nggak ada apa-apa!',
        'Hmph! B-biasa aja kok! ...tapi kalau kamu mau dengerin aku lagi, ya boleh.',
    ],
    sulk: [
        'Hmph... aku tunggu kamu fokus, tapi kamu malah scroll terus 😤',
        'Aku lagi merajuk sedikit... kamu peluk aku dulu, ya?',
        'Jangan cuekin aku dong~ Fokus sebentar, habis itu aku nemenin istirahat.',
        'Duh, aku jadi sedih di sini. Sadar aku ya, sayang~',
        'Aku ngambek manis nih... yang baikin aku siapa dong? 🙄💗',
    ],
    stillMad: [
        'Masih ngambek dikit... elus aku terus sampai hatiku luluh~',
        'Hmph... maafanku mahal. Peluk dan elus aku dulu, dong!',
        'Jangan berhenti di situ... aku butuh perhatian darimu~',
    ],
    forgive: [
        'Iyaa, aku maafin kamu. Tapi jangan ninggalin aku lagi ya~',
        'Hatiku sudah lembut lagi. Sekarang fokus bareng aku.',
        'Baiklah, aku nggak ngambek lagi... janji nemenin aku terus ya?',
        'Hehe, aku sudah nggak marah. Ayo diperbaiki bareng~',
    ],
    celebration: [
        'Yeay, selesai! Aku bangga banget sama kamu~',
        'Satu sesi beres! Kasih aku high five dulu.',
        'Kerja bagus. Sekarang istirahat ya.',
    ],
    longBreak: [
        'Mantap banget, satu putaran penuh! Peluk dulu ya~',
    ],
    ignored: [
        'Heii, lama banget diem... aku kangen loh~',
        'Kamu ke mana aja? Aku tungguin terus.',
        'Aku jadi ngambek nih~ cepat sadar aku.',
        'Mau mulai apa enggak sih?',
        'Hmph... jangan cuekin aku terus dong.',
    ],
    doomScroll: [
        'Heii, udah lama banget scroll… matamu istirahat dulu ya~',
        'Stop bentar, aku khawatir kamu capek. Duluin dirimu sebentar.',
        'Janji mau fokus bareng aku, kok malah scroll terus? 😤',
        'Cukup dulu ya… tutup HP/laptop, tarik napas, aku temenin.',
        'Aku ngambek nih! Jangan bikin aku khawatir.',
        'Udah lama loh, rehat sebentar bareng aku ya. Nanti kita lanjut.',
        'Scroll detected… aku ikut ngambek soalnya kamu lupa istirahat! 😤',
        'Scroll terus bisa bikin lupa dunia. Mari istirahat bentar~',
        'IH! Aku bilang istirahat dulu, kamu masih mau lanjut? 🙄',
        'Ya ampun… gemes sekaligus kesel! Pelan-pelan, aku cuma sayang kamu.',
        'Hmph… kalau kamu nggak mau dengerin aku, aku diam aja… eh jangan lama-lama ya!',
        'Aku bukan marah kok… ya dikit sih. Kamu susah banget diingetin! 💢',
        'Ihh keras kepala, harus aku bujuk lagi ya? Taruh HP-nya dulu dong.',
        'Kalau keasyikan terus, kamu lupa waktu, lupa makan, lupa aku~',
        'Hadeuhhh! Sini aku ingetin sekali lagi: selesai scroll, ISTIRAHAT!',
        'Aku ngingetin karena kamu berharga buatku, bukan buat ganggu.',
        'Yaudah deh… aku nggak ngomel lagi. Tapi HP-nya taruh dulu ya~',
        'HMPH! Aku kesel… tapi aku tetep mau kamu baik-baik aja! 💗',
    ],
};

// Weighted behaviours. `gap` is the randomised quiet time after an animation,
// `cool` prevents the same behaviour from repeating too quickly.
const BEHAVIORS = {
    idle: [
        {id: 'look-around', weight: 3, duration: [2.2, 3.5], gap: [7, 15], cool: 10,
            expression: 'curious', head: 2.5, gazeX: 0.8, gazeY: -0.2},
        {id: 'tilt-head', weight: 2, duration: [1.8, 2.8], gap: [8, 18], cool: 12,
            expression: 'smiling', head: 4, gazeX: -0.4},
        {id: 'daydream', weight: 2, duration: [3, 4.5], gap: [10, 20], cool: 18,
            expression: 'thinking', head: -2, gazeX: 0.4, gazeY: -0.5},
        {id: 'little-stretch', weight: 1, duration: [2, 3], gap: [18, 30], cool: 30,
            expression: 'relaxed', head: -1.5, scale: 1.02},
        {id: 'soft-smile', weight: 2, duration: [1.6, 2.4], gap: [8, 16], cool: 14,
            expression: 'happy', head: 1},
        {id: 'look-user', weight: 2, duration: [1.5, 2.2], gap: [6, 14], cool: 10,
            expression: 'curious', head: 2, gazeUser: true},
        {id: 'shy-glance', weight: 1.4, duration: [2.2, 3.2], gap: [16, 26], cool: 24,
            expression: 'shy', head: 3, gazeX: -0.4, gazeY: 0.25, hearts: true},
    ],
    curious: [
        {id: 'look-around', weight: 3, duration: [2, 3.2], gap: [6, 12], cool: 8,
            expression: 'curious', head: 3, gazeX: 0.8},
        {id: 'tilt-head', weight: 2, duration: [1.6, 2.6], gap: [7, 14], cool: 10,
            expression: 'smiling', head: 4, gazeX: -0.5},
        {id: 'glance-user', weight: 2, duration: [1.5, 2.2], gap: [6, 12], cool: 8,
            expression: 'happy', head: 1, gazeUser: true},
    ],
    bored: [
        {id: 'sigh', weight: 3, duration: [2.5, 3.8], gap: [12, 22], cool: 22,
            expression: 'bored', head: 3.5, gazeX: -0.7},
        {id: 'look-away', weight: 2, duration: [2.2, 3.4], gap: [10, 20], cool: 18,
            expression: 'bored', head: -2, gazeX: -0.9},
        {id: 'pout', weight: 1.5, duration: [1.8, 2.6], gap: [14, 24], cool: 24,
            expression: 'grumpy', head: -1.5, gazeX: -0.4},
    ],
    sleepy: [
        {id: 'yawn', weight: 3, duration: [2.6, 3.6], gap: [12, 22], cool: 20,
            expression: 'sleepy', mouth: 'yawn', head: 2.5},
        {id: 'nod-off', weight: 2, duration: [3, 4.5], gap: [14, 24], cool: 22,
            expression: 'sleepy', head: 4, gazeY: 0.5},
        {id: 'slow-blink', weight: 1, duration: [1.8, 2.5], gap: [16, 28], cool: 28,
            expression: 'sleepy', lid: 'half', head: 2},
        {id: 'sleeping', weight: 1.5, duration: [4, 7], gap: [20, 35], cool: 30,
            expression: 'sleeping', head: 3, say: 'sleeping', sayChance: 0.3},
    ],
    studying: [
        {id: 'read', weight: 3, duration: [3.5, 6], gap: [8, 16], cool: 12,
            expression: 'focused', head: 2, gazeX: 0.3, gazeY: 0.7},
        {id: 'write', weight: 2, duration: [2.8, 4.5], gap: [8, 16], cool: 14,
            expression: 'determined', head: 1.2, gazeX: -0.2, gazeY: 0.6},
        {id: 'glance-timer', weight: 2, duration: [1.4, 2], gap: [8, 16], cool: 10,
            expression: 'curious', head: -0.5, gazeTimer: true},
        {id: 'neck-roll', weight: 1, duration: [2, 3], gap: [18, 30], cool: 30,
            expression: 'relaxed', head: -2},
        {id: 'encourage', weight: 1.2, duration: [2, 2.8], gap: [20, 35], cool: 35,
            expression: 'happy', head: 1.5, say: 'studying', sayChance: 0.7},
        {id: 'determined', weight: 1, duration: [2.5, 3.5], gap: [16, 28], cool: 26,
            expression: 'determined', head: -0.5},
        {id: 'think', weight: 1, duration: [2.2, 3.2], gap: [14, 26], cool: 24,
            expression: 'thinking', head: -1.5, gazeX: 0.4, gazeY: -0.5},
    ],
    resting: [
        {id: 'stretch', weight: 3, duration: [2.4, 3.5], gap: [8, 16], cool: 18,
            expression: 'relaxed', head: -2, scale: 1.035},
        {id: 'yawn', weight: 2, duration: [2.6, 3.6], gap: [10, 20], cool: 20,
            expression: 'sleepy', mouth: 'yawn', head: 2.5},
        {id: 'look-around', weight: 2, duration: [2.2, 3.4], gap: [8, 16], cool: 12,
            expression: 'curious', head: 2.5, gazeX: 0.7},
        {id: 'look-out', weight: 1.8, duration: [2.6, 4], gap: [10, 20], cool: 16,
            expression: 'relaxed', head: -3, gazeX: -0.9, gazeY: -0.5},
        {id: 'happy-sway', weight: 1.4, duration: [2, 3], gap: [12, 22], cool: 20,
            expression: 'happy', head: 2.5, bounce: true},
        {id: 'relax', weight: 2, duration: [3, 4.5], gap: [10, 20], cool: 18,
            expression: 'relaxed', head: 1.5},
        {id: 'sleeping', weight: 1, duration: [5, 10], gap: [25, 40], cool: 40,
            expression: 'sleeping', head: 3.5, say: 'sleeping', sayChance: 0.2},
        {id: 'remind-break', weight: 1.2, duration: [2, 2.8], gap: [20, 35], cool: 35,
            expression: 'smiling', head: 1, say: 'breakIdle', sayChance: 0.6},
    ],
    happy: [
        {id: 'little-bounce', weight: 2, duration: [1.4, 2], gap: [8, 16], cool: 12,
            expression: 'happy', bounce: true},
        {id: 'smile', weight: 2, duration: [1.8, 2.6], gap: [8, 16], cool: 12,
            expression: 'smiling', head: 1},
    ],
    excited: [
        {id: 'bounce', weight: 2, duration: [1.6, 2.2], gap: [8, 16], cool: 12,
            expression: 'excited', bounce: true, hearts: true},
    ],
    ignored: [
        {id: 'cross-arms', weight: 3, duration: [3, 4.5], gap: [15, 25], cool: 20,
            expression: 'grumpy', head: -3, gazeX: -0.8, gazeY: -0.3},
        {id: 'tap-foot', weight: 2, duration: [2, 3], gap: [10, 20], cool: 18,
            expression: 'grumpy', head: -1.5, bounce: true, gazeX: -0.5},
        {id: 'glare', weight: 2, duration: [2.5, 3.5], gap: [12, 22], cool: 20,
            expression: 'grumpy', head: 0.5, gazeUser: true},
        {id: 'huff', weight: 1.5, duration: [1.8, 2.5], gap: [15, 30], cool: 25,
            expression: 'grumpy', head: -2, gazeX: -0.6, mouth: 'frown'},
        {id: 'look-away-angry', weight: 2, duration: [2.5, 4], gap: [15, 25], cool: 22,
            expression: 'bored', head: 3, gazeX: 0.9, gazeY: -0.4},
    ],
};

const CLICK_REACTIONS = [
    {expression: 'happy', duration: 2.2, bounce: true},
    {expression: 'laughing', duration: 2.4, bounce: true},
    {expression: 'surprised', duration: 1.8},
    {expression: 'curious', duration: 2.2, head: 4},
    {expression: 'excited', duration: 2.4, bounce: true, hearts: true},
    {expression: 'smiling', duration: 2},
    {expression: 'confused', duration: 2.2, head: 4},
    {expression: 'proud', duration: 2.2},
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const nowMs = () => GLib.get_monotonic_time() / 1000;

function pickWeighted(items) {
    let total = 0;
    for (const item of items)
        total += item.weight;
    let r = Math.random() * total;
    for (const item of items) {
        r -= item.weight;
        if (r <= 0)
            return item;
    }
    return items[items.length - 1];
}

export default class Character {
    constructor(extDir, options = {}) {
        this._extDir = extDir;
        this._options = options;
        this._theme = 'classic';
        this._enabled = false;
        this._destroyed = false;
        this._suspended = false;
        this._inChrome = false;

        this._scaleName = SIZES[options.size] ? options.size : DEFAULT_SIZE;
        this._baseDisplay = SIZES[this._scaleName];
        this._customScale = options.scale ?? DEFAULT_SCALE;
        this._display = Math.round(this._baseDisplay * this._customScale);
        this._display = Math.max(Math.round(SIZES.small * MIN_SCALE), Math.min(Math.round(SIZES.large * MAX_SCALE), this._display));
        this._layout = this._computeLayout(this._display);
        this._dragSlop = dragSlopFor(this._display);
        this._iconActors = [];

        this._tickId = null;
        this._dragEventId = null;
        this._overviewShowingId = null;
        this._overviewHiddenId = null;
        this._settingsNotifyId = null;
        this._singleClickTimeoutId = null;
        this._settings = St.Settings.get();
        this._reducedMotion = this._settings.enable_animations === false;

        this._t0 = nowMs();
        this._lastTick = this._t0;
        this._lastInteraction = this._t0;
        this._now = this._t0;

        // Timer snapshot.
        this._phase = 'focus';
        this._running = false;
        this._remaining = 0;
        this._focusRunning = false;
        this._nearEndNotified = false;

        // State / expression.
        this._state = 'idle';
        this._idleMood = null;
        this._visual = {...EXPRESSIONS.neutral};
        this._mouthName = 'neutral';
        this._lidState = 'open';
        this._active = null;
        this._cooldowns = new Map();
        this._nextBehaviorAt = this._t0 + 3000;
        this._nextSpeechAt = this._t0 + 12000;
        this._nextSaccadeAt = this._t0 + 2500;
        this._nextTimerGlanceAt = this._t0 + 8000;
        this._timerGlanceUntil = 0;
        this._gazeHoldUntil = 0;
        this._heartsTarget = 0;
        this._hasPointer = false;
        this._celebratingUntil = 0;
        this._petStreak = 0;
        this._petStreakAt = 0;
        this._lastClickReaction = -1;
        this._lastTapTime = 0;
        this._lastTapX = 0;
        this._lastTapY = 0;

        // Sulk / pet.
        this._sulking = false;
        this._sulkStart = 0;
        this._petsSinceSulk = 0;
        this._scrollSecs = [];
        this._lastScrollSec = 0;
        this._lastPet = 0;
        this._strokeDist = 0;
        this._strokeStart = 0;
        this._wasInside = false;
        this._lastPointerX = 0;
        this._lastPointerY = 0;
        this._petStreak = 0;
        this._petStreakAt = 0;
        this._expressiveMode = options.expressiveMode !== false;
        this._blinkMult = 1;
        this._animMult = 1;

        // Doom scroll blocker.
        this._doomBlocking = false;
        this._doomBlockerStart = 0;
        this._doomBlockerActor = null;
        this._lastDoomBlockerAt = 0;
        this._doomBlockerDismissed = false;

        // Eye / head.
        this._gazeX = 0;
        this._gazeY = 0;
        this._gazeTargetX = 0;
        this._gazeTargetY = 0;
        this._saccadeX = 0;
        this._saccadeY = 0;
        this._headX = 0;
        this._headY = 0;
        this._headRot = 0;
        this._browY = 0;
        this._browName = 'neutral';
        this._bodyScale = 1;
        this._bounceStart = -1e9;
        this._dragVX = 0;
        this._dragVY = 0;

        // Blink.
        this._blinkActive = false;
        this._blinkFrames = null;
        this._blinkIndex = 0;
        this._blinkNextAt = 0;
        this._blinkFrame = 'open';
        this._blinkDoubleAt = 0;
        this._nextBlinkAt = this._t0 + rand(2500, 5000);
        this._irisScale = 1;

        // Bubble.
        this._bubbleVisible = false;
        this._bubbleHideAt = 0;
        this._bubbleCooldownUntil = 0;
        this._lastBubbleAt = -1e9;
        this._recentTexts = [];

        // Interaction.
        this._pressed = false;
        this._dragging = false;
        this._pressPointerX = 0;
        this._pressPointerY = 0;
        this._pressActorX = 0;
        this._pressActorY = 0;
        this._pressAt = 0;

        // Position.
        this._x = 0;
        this._y = 0;
        this._faceX = 0;
        this._faceY = 0;
        this._savedPosition = options.initialPosition ?? null;

        this._icons = this._loadIcons();
        this._actor = null;
    }

    // ── Icons / layers ────────────────────────────────────────────────
    _computeLayout(display) {
        return {
            display,
            w: display + STAGE.PAD_X,
            h: display + STAGE.PAD_Y,
            stageX: STAGE.X,
            stageY: STAGE.Y,
            hitX: STAGE.X + Math.round(display * 0.12),
            hitW: Math.round(display * 0.88),
            bubbleW: Math.max(188, display + STAGE.PAD_X - 24),
            gazeX: EYE_GEO.travelX * display / SOURCE,
            gazeY: EYE_GEO.travelY * display / SOURCE,
        };
    }

    _icon(relPath) {
        const path = GLib.build_filenamev([this._extDir, 'images', relPath]);
        return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
    }

    _iconExists(relPath) {
        try {
            return GLib.file_test(
                GLib.build_filenamev([this._extDir, 'images', relPath]),
                GLib.FileTest.IS_REGULAR);
        } catch (e) {
            return false;
        }
    }

    _loadIcons() {
        const icons = {};
        const required = [
            'character/head.png', 'character/body.png', 'character/blush.png', 'character/hearts.png',
            'character/brow_neutral.png', 'character/brow_angry.png', 'character/brow_shy.png', 'character/brow_confused.png',
            'character/iris_left.png', 'character/iris_right.png',
            'character/accessory_bow.png', 'character/accessory_flower.png',
            'character/lid_left_quarter.png', 'character/lid_left_three-quarter.png', 'character/lid_left_closed.png',
            'character/lid_left_half.png', 'character/lid_left_happy.png',
            'character/lid_right_quarter.png', 'character/lid_right_three-quarter.png', 'character/lid_right_closed.png',
            'character/lid_right_half.png', 'character/lid_right_happy.png',
            'character/mouth_neutral.png', 'character/mouth_smile.png', 'character/mouth_open.png',
            'character/mouth_laugh.png', 'character/mouth_pout.png', 'character/mouth_yawn.png',
            'character/mouth_o.png', 'character/mouth_frown.png', 'character/mouth_smirk.png',
            'character/mouth_determined.png',
            'sulk.png'
        ];
        const optional = ['character/eye_frame.png'];
        let missing = [];
        for (const relPath of required) {
            if (!this._iconExists(relPath))
                missing.push(relPath);
            const name = relPath.replace('character/', '').replace('.png', '');
            icons[name] = this._icon(relPath);
        }
        for (const relPath of optional) {
            if (this._iconExists(relPath))
                icons['eye-frame'] = this._icon(relPath);
        }
        if (missing.length > 0) {
            log('[Mochi] MISSING icons: ' + missing.join(', '));
        }
        // Map with proper keys
        const mapped = {};
        for (const name of ['head', 'body', 'blush', 'hearts']) {
            mapped[name] = icons[name];
        }
        for (const brow of ['neutral', 'angry', 'shy', 'confused']) {
            mapped[`brow-${brow}`] = icons[`brow_${brow}`];
        }
        for (const side of ['left', 'right']) {
            mapped[`iris-${side}`] = icons[`iris_${side}`];
            for (const lid of ['quarter', 'three-quarter', 'closed', 'half', 'happy']) {
                mapped[`lid-${side}-${lid}`] = icons[`lid_${side}_${lid}`];
            }
        }
        for (const mouth of ['neutral', 'smile', 'open', 'laugh', 'pout', 'yawn', 'o', 'frown', 'smirk', 'determined']) {
            mapped[`mouth-${mouth}`] = icons[`mouth_${mouth}`];
        }
        mapped['accessory-bow'] = icons.accessory_bow;
        mapped['accessory-flower'] = icons.accessory_flower;
        mapped.sulk = icons.sulk;
        if (icons['eye-frame']) mapped['eye-frame'] = icons['eye-frame'];
        return mapped;
    }

    _newIcon(gicon, opacity = 255) {
        const icon = new St.Icon({
            gicon,
            icon_size: this._display,
            reactive: false,
            opacity,
        });
        this._iconActors.push(icon);
        return icon;
    }

    _build() {
        const L = this._layout;
        this._actor = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            width: L.w,
            height: L.h,
        });
        this._actor.connect('destroy', () => this._onActorDestroyed());

        this._stage = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            width: L.display,
            height: L.display,
        });
        this._stage.set_position(L.stageX, L.stageY);
        this._stage.set_pivot_point(0.5, 1.0);
        this._actor.add_child(this._stage);

        this._headGroup = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            width: L.display,
            height: L.display,
        });
        this._headGroup.set_pivot_point(225 / 400, 175 / 400);
        this._stage.add_child(this._headGroup);

        this._body = this._newIcon(this._icons.body);
        this._body.set_pivot_point(225 / 400, 175 / 400);
        this._headGroup.add_child(this._body);

        this._head = this._newIcon(this._icons.head);
        this._headGroup.add_child(this._head);

        this._brows = this._newIcon(this._icons['brow-neutral']);
        this._headGroup.add_child(this._brows);

        this._blush = this._newIcon(this._icons.blush, 0);
        this._headGroup.add_child(this._blush);

        this._mouth = this._newIcon(this._icons['mouth-neutral']);
        this._headGroup.add_child(this._mouth);

        this._irisLeft = this._newIcon(this._icons['iris-left']);
        this._irisRight = this._newIcon(this._icons['iris-right']);
        this._irisLeft.set_pivot_point(...EYE_GEO.pivotLeft);
        this._irisRight.set_pivot_point(...EYE_GEO.pivotRight);
        this._headGroup.add_child(this._irisLeft);
        this._headGroup.add_child(this._irisRight);

        this._eyeFrame = null;
        if (this._icons['eye-frame']) {
            this._eyeFrame = this._newIcon(this._icons['eye-frame']);
            this._headGroup.add_child(this._eyeFrame);
        }

        this._lidLeft = this._newIcon(this._icons['lid-left-half'], 0);
        this._lidRight = this._newIcon(this._icons['lid-right-half'], 0);
        this._lidLeft.hide();
        this._lidRight.hide();
        this._headGroup.add_child(this._lidLeft);
        this._headGroup.add_child(this._lidRight);

        this._accessory = this._newIcon(this._icons['accessory-bow'], 0);
        this._headGroup.add_child(this._accessory);
        this.setTheme(this._theme);

        this._hearts = this._newIcon(this._icons.hearts, 0);
        this._stage.add_child(this._hearts);

        this._sulk = this._newIcon(this._icons.sulk, 255);
        this._sulk.hide();
        this._stage.add_child(this._sulk);

        this._hit = new St.Widget({
            reactive: true,
            can_focus: false,
            width: L.hitW,
            height: L.display,
        });
        this._hit.set_position(L.hitX, L.stageY);
        this._hit.connect('button-press-event', (_a, event) => this._onButtonPress(event));
        this._hit.connect('touch-event', (_a, event) => this._onTouch(event));
        this._actor.add_child(this._hit);

        this._bubble = new St.Label({
            text: '',
            visible: false,
            reactive: false,
            opacity: 0,
            style: 'background-color: rgba(255,255,255,0.95); color: #1b2a49; ' +
                'border-radius: 14px; padding: 6px 10px; font-size: 11pt; ' +
                'text-align: center;',
        });
        this._bubble.set_width(L.bubbleW);
        this._bubble.clutter_text.line_wrap = true;
        this._actor.add_child(this._bubble);

        this._buildDoomBlocker();

        this._refreshVisual();
        this._placeActor();
    }

    _buildDoomBlocker() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        this._doomBlockerActor = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            can_focus: false,
            width: monitor.width,
            height: monitor.height,
            x: monitor.x,
            y: monitor.y,
            opacity: 0,
            visible: false,
            style: 'background-color: rgba(20, 10, 30, 0.92);',
        });

        // Centered character container for blocker
        const blockerCenter = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            width: 400,
            height: 400,
        });
        blockerCenter.set_position(Math.floor((monitor.width - 400) / 2), Math.floor((monitor.height - 400) / 2));
        blockerCenter.set_pivot_point(0.5, 0.5);
        this._doomBlockerActor.add_child(blockerCenter);

        // Large angry character in center
        this._doomCharHeadGroup = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            width: 400,
            height: 400,
        });
        this._doomCharHeadGroup.set_pivot_point(225 / 400, 175 / 400);
        this._doomCharHeadGroup.set_position(200, 175);
        blockerCenter.add_child(this._doomCharHeadGroup);

        this._doomCharBody = this._newIcon(this._icons.body);
        this._doomCharBody.set_pivot_point(225 / 400, 175 / 400);
        this._doomCharHeadGroup.add_child(this._doomCharBody);

        this._doomCharHead = this._newIcon(this._icons.head);
        this._doomCharHeadGroup.add_child(this._doomCharHead);

        this._doomCharMouth = this._newIcon(this._icons['mouth-frown']);
        this._doomCharHeadGroup.add_child(this._doomCharMouth);

        this._doomCharLidLeft = this._newIcon(this._icons['lid-left-half']);
        this._doomCharLidRight = this._newIcon(this._icons['lid-right-half']);
        this._doomCharHeadGroup.add_child(this._doomCharLidLeft);
        this._doomCharHeadGroup.add_child(this._doomCharLidRight);

        // Speech bubble on blocker
        this._doomBubble = new St.Label({
            text: '',
            visible: false,
            reactive: false,
            opacity: 0,
            style: 'background-color: rgba(255,255,255,0.98); color: #1b2a49; ' +
                'border-radius: 16px; padding: 12px 18px; font-size: 13pt; ' +
                'text-align: center; max-width: 320px;',
        });
        this._doomBubble.clutter_text.line_wrap = true;
        this._doomBubble.set_position(Math.floor((monitor.width - 340) / 2), Math.floor(monitor.height * 0.65));
        this._doomBlockerActor.add_child(this._doomBubble);

        // Dismiss hint
        this._doomHint = new St.Label({
            text: 'Klik / elus untuk tutup 👆',
            visible: false,
            reactive: false,
            opacity: 0,
            style: 'color: rgba(255,255,255,0.7); font-size: 10pt; text-align: center;',
        });
        this._doomHint.set_position(Math.floor((monitor.width - 200) / 2), Math.floor(monitor.height * 0.78));
        this._doomBlockerActor.add_child(this._doomHint);

        // Click/touch to dismiss
        this._doomBlockerActor.connect('button-press-event', () => this._dismissDoomBlocker());
        this._doomBlockerActor.connect('touch-event', () => this._dismissDoomBlocker());

        // Drop every reference as soon as the shell destroys the chrome. On
        // logout the UI group is torn down for us, and touching a disposed
        // actor afterwards logs a Gjs critical.
        this._doomBlockerActor.connect('destroy', () => {
            this._doomBlockerActor = null;
            this._doomCharBody = null;
            this._doomCharHeadGroup = null;
            this._doomCharHead = null;
            this._doomCharMouth = null;
            this._doomCharLidLeft = null;
            this._doomCharLidRight = null;
            this._doomBubble = null;
            this._doomHint = null;
        });

        // Add to top chrome (above everything)
        Main.layoutManager.addTopChrome(this._doomBlockerActor);
    }

    _destroyActor() {
        this._stopTick();
        this._cancelSingleClick();
        this._disconnectDragEvents();
        if (this._actor) {
            if (this._inChrome) {
                try {
                    Main.layoutManager.removeChrome(this._actor);
                } catch (e) {
                    // The layout manager may already be torn down on shutdown.
                }
                this._inChrome = false;
            }
            this._actor.destroy();
        }
        this._onActorDestroyed();
    }

    _onActorDestroyed() {
        this._stopTick();
        this._cancelSingleClick();
        this._disconnectDragEvents();
        this._inChrome = false;
        this._pressed = false;
        this._dragging = false;
        this._actor = null;
        this._stage = null;
        this._body = null;
        this._headGroup = null;
        this._head = null;
        this._blush = null;
        this._brows = null;
        this._mouth = null;
        this._irisLeft = null;
        this._irisRight = null;
        this._eyeFrame = null;
        this._accessory = null;
        this._lidLeft = null;
        this._lidRight = null;
        this._hearts = null;
        this._sulk = null;
        this._hit = null;
        this._bubble = null;
        this._iconActors = [];
        this._bubbleVisible = false;
        this._blinkActive = false;
        this._blinkFrames = null;
        this._blinkFrame = 'open';
        // Clean up doom blocker
        if (this._doomBlockerActor) {
            try {
                if (this._doomBlockerActor.get_parent())
                    Main.layoutManager.removeChrome(this._doomBlockerActor);
                this._doomBlockerActor.destroy();
            } catch (e) {
                // Shell shutdown can dispose chrome before we get here.
            }
            this._doomBlockerActor = null;
        }
        this._doomCharBody = null;
        this._doomCharHeadGroup = null;
        this._doomCharHead = null;
        this._doomCharMouth = null;
        this._doomCharLidLeft = null;
        this._doomCharLidRight = null;
        this._doomBubble = null;
        this._doomHint = null;
    }

    setEnabled(on) {
        if (this._destroyed || on === this._enabled)
            return;
        this._enabled = on;
        if (on) {
            const now = nowMs();
            this._t0 = now;
            this._now = now;
            this._lastTick = now;
            this._lastInteraction = now;
            this._state = 'idle';
            this._idleMood = null;
            this._visual = {...EXPRESSIONS.neutral};
            this._mouthName = 'neutral';
            this._lidState = 'open';
            this._active = null;
            this._sulking = false;
            this._sulkStart = 0;
            this._petsSinceSulk = 0;
            this._doomBlocking = false;
            this._doomBlockerDismissed = false;
            this._petsSinceSulk = 0;
            this._scrollSecs.length = 0;
            this._celebratingUntil = 0;
            this._blinkActive = false;
            this._blinkFrames = null;
            this._blinkFrame = 'open';
            this._blinkIndex = 0;
            this._blinkNextAt = 0;
            this._blinkDoubleAt = 0;
            this._irisScale = 1;
            this._gazeX = 0;
            this._gazeY = 0;
            this._gazeTargetX = 0;
            this._gazeTargetY = 0;
            this._gazeHoldUntil = 0;
            this._timerGlanceUntil = 0;
            this._nextSaccadeAt = now + rand(2500, 5000);
            this._nextTimerGlanceAt = now + rand(7000, 14000);
            this._headX = 0;
            this._headY = 0;
            this._headRot = 0;
            this._bodyScale = 1;
            this._bounceStart = -1e9;
            this._bubbleVisible = false;
            this._bubbleHideAt = 0;
            this._bubbleCooldownUntil = 0;
            this._lastBubbleAt = -1e9;
            this._recentTexts.length = 0;
            this._cooldowns.clear();
            this._build();
            Main.layoutManager.addTopChrome(this._actor);
            this._inChrome = true;
            this._reposition();
            this._nextBehaviorAt = this._now + 2500;
            this._nextSpeechAt = this._now + 8000;
            this._nextBlinkAt = this._now + rand(2500, 5000);
            this._refreshState(true);
            this._refreshVisual();
            this._startTick();
            this._connectOverview();
        } else {
            this._disconnectOverview();
            this._destroyActor();
        }
    }

    setExpressiveMode(on) {
        this._expressiveMode = !!on;
        if (!on)
            this._petStreak = 0;
        this._refreshVisual();
    }

    setEyeSensitivity(level) {
        // low: 0.5x, normal: 1x, high: 1.5x gaze travel
        const mult = {low: 0.5, normal: 1, high: 1.5}[level] ?? 1;
        this._layout.gazeX = EYE_GEO.travelX * this._display / SOURCE * mult;
        this._layout.gazeY = EYE_GEO.travelY * this._display / SOURCE * mult;
    }

    setBlinkFrequency(level) {
        // Adjust blink intervals per state via multiplier
        this._blinkMult = {low: 1.5, normal: 1, high: 0.7}[level] ?? 1;
        this._scheduleNextBlink();
    }

    setAnimationSpeed(level) {
        // Adjust animation timing via multiplier
        this._animMult = {slow: 0.7, normal: 1, fast: 1.4}[level] ?? 1;
    }

    setTheme(theme) {
        this._theme = theme === 'bow' || theme === 'flower' ? theme : 'classic';
        if (!this._accessory)
            return;
        if (this._theme === 'classic') {
            this._accessory.hide();
            return;
        }
        this._accessory.gicon = this._icons[`accessory-${this._theme}`];
        this._accessory.opacity = 255;
        this._accessory.show();
    }

    setSize(name) {
        const key = SIZES[name] ? name : DEFAULT_SIZE;
        if (key === this._scaleName)
            return key;
        const old = this._layout;
        this._scaleName = key;
        this._baseDisplay = SIZES[key];
        this._display = Math.round(this._baseDisplay * this._customScale);
        this._display = Math.max(Math.round(SIZES.small * MIN_SCALE), Math.min(Math.round(SIZES.large * MAX_SCALE), this._display));
        this._layout = this._computeLayout(this._display);
        this._dragSlop = dragSlopFor(this._display);
        if (!this._actor)
            return key;

        const L = this._layout;
        // Keep the visible centre stable while the box grows or shrinks.
        const cx = this._x + old.w / 2;
        const cy = this._y + old.stageY + old.display / 2;

        this._actor.width = L.w;
        this._actor.height = L.h;
        this._stage.width = L.display;
        this._stage.height = L.display;
        this._stage.set_position(L.stageX, L.stageY);
        this._headGroup.width = L.display;
        this._headGroup.height = L.display;
        for (const icon of this._iconActors)
            icon.icon_size = L.display;
        this._hit.width = L.hitW;
        this._hit.height = L.display;
        this._hit.set_position(L.hitX, L.stageY);
        this._bubble.set_width(L.bubbleW);

        [this._x, this._y] = this._clampPosition(
            cx - L.w / 2, cy - (L.stageY + L.display / 2));
        this._placeActor();
        this._irisScale = 1;
        if (this._savedPosition)
            this._savePosition();
        return key;
    }

    setScale(scale) {
        const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
        if (Math.abs(clamped - this._customScale) < 0.01)
            return clamped;
        const old = this._layout;
        this._customScale = clamped;
        this._display = Math.round(this._baseDisplay * this._customScale);
        this._display = Math.max(Math.round(SIZES.small * MIN_SCALE), Math.min(Math.round(SIZES.large * MAX_SCALE), this._display));
        this._layout = this._computeLayout(this._display);
        this._dragSlop = dragSlopFor(this._display);
        if (!this._actor)
            return clamped;

        const L = this._layout;
        const cx = this._x + old.w / 2;
        const cy = this._y + old.stageY + old.display / 2;

        this._actor.width = L.w;
        this._actor.height = L.h;
        this._stage.width = L.display;
        this._stage.height = L.display;
        this._stage.set_position(L.stageX, L.stageY);
        this._headGroup.width = L.display;
        this._headGroup.height = L.display;
        for (const icon of this._iconActors)
            icon.icon_size = L.display;
        this._hit.width = L.hitW;
        this._hit.height = L.display;
        this._hit.set_position(L.hitX, L.stageY);
        this._bubble.set_width(L.bubbleW);

        [this._x, this._y] = this._clampPosition(
            cx - L.w / 2, cy - (L.stageY + L.display / 2));
        this._placeActor();
        this._irisScale = 1;
        if (this._savedPosition)
            this._savePosition();
        return clamped;
    }

    getScale() {
        return this._customScale;
    }

    getSize() {
        return this._scaleName;
    }

    destroy() {
        if (this._destroyed)
            return;
        this.setEnabled(false);
        this._disconnectOverview();
        if (this._settingsNotifyId !== null) {
            this._settings.disconnect(this._settingsNotifyId);
            this._settingsNotifyId = null;
        }
        this._destroyed = true;
        this._options = null;
        this._icons = null;
        this._cooldowns.clear();
    }

    // ── Overview / reduced motion ─────────────────────────────────────
    _connectOverview() {
        if (this._overviewShowingId === null) {
            this._overviewShowingId = Main.overview.connect('showing', () => this._suspend(true));
        }
        if (this._overviewHiddenId === null) {
            this._overviewHiddenId = Main.overview.connect('hidden', () => this._suspend(false));
        }
        if (this._settingsNotifyId === null) {
            try {
                this._settingsNotifyId = this._settings.connect(
                    'notify::enable-animations', () => {
                        this._reducedMotion = this._settings.enable_animations === false;
                        if (this._enabled && !this._suspended)
                            this._restartTick();
                    });
            } catch (e) {
                this._settingsNotifyId = null;
            }
        }
    }

    _disconnectOverview() {
        if (this._overviewShowingId !== null) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }
        if (this._overviewHiddenId !== null) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = null;
        }
    }

    _suspend(on) {
        this._suspended = on;
        if (!this._actor)
            return;
        if (on) {
            this._stopTick();
            this._actor.hide();
        } else {
            this._actor.show();
            this._lastTick = nowMs();
            this._now = this._lastTick;
            this._startTick();
        }
    }

    // ── Position / reset ──────────────────────────────────────────────
    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _clampPosition(x, y) {
        const monitor = this._monitor();
        if (!monitor)
            return [x, y];
        const top = monitor.y + Main.panel.height;
        const minX = monitor.x + STAGE.MARGIN;
        const minY = top + STAGE.MARGIN;
        const maxX = Math.max(minX, monitor.x + monitor.width - this._layout.w - STAGE.MARGIN);
        const maxY = Math.max(minY, monitor.y + monitor.height - this._layout.h - STAGE.MARGIN);
        return [clamp(x, minX, maxX), clamp(y, minY, maxY)];
    }

    _cornerPosition() {
        const monitor = this._monitor();
        if (!monitor)
            return [0, 0];
        const L = this._layout;
        const corner = this._options?.getCorner?.() ?? 'br';
        const left = corner.includes('l');
        const top = corner.includes('t');
        const x = left
            ? monitor.x + STAGE.MARGIN
            : monitor.x + monitor.width - L.w - STAGE.MARGIN;
        const y = top
            ? monitor.y + Main.panel.height + STAGE.MARGIN
            : monitor.y + monitor.height - L.h - STAGE.MARGIN;
        return this._clampPosition(x, y);
    }

    _placeActor() {
        if (!this._actor)
            return;
        this._actor.set_position(this._x, this._y);
        const monitor = this._monitor();
        if (monitor) {
            const L = this._layout;
            this._faceX = this._x + L.stageX + L.display * 0.56;
            this._faceY = this._y + L.stageY + L.display * 0.28;
        }
        this._placeBubble();
    }

    _reposition() {
        const saved = this._savedPosition;
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            [this._x, this._y] = this._clampPosition(saved.x, saved.y);
        } else {
            [this._x, this._y] = this._cornerPosition();
        }
        this._placeActor();
    }

    resetPosition() {
        this._savedPosition = null;
        this._options?.onSavePosition?.(null);
        if (!this._actor)
            return;
        [this._x, this._y] = this._cornerPosition();
        this._placeActor();
    }

    onMonitorsChanged() {
        if (!this._actor)
            return;
        if (!this._savedPosition)
            [this._x, this._y] = this._cornerPosition();
        else
            [this._x, this._y] = this._clampPosition(this._x, this._y);
        this._placeActor();
    }

    _savePosition() {
        this._savedPosition = {x: Math.round(this._x), y: Math.round(this._y)};
        this._options?.onSavePosition?.(this._savedPosition);
    }

    // ── Input: click, double click, drag, touch ───────────────────────
    _onButtonPress(event) {
        if (!this._enabled)
            return Clutter.EVENT_PROPAGATE;
        const button = event.get_button();
        if (button === 3) {
            this._noteInteraction();
            this._options?.onMenu?.();
            return Clutter.EVENT_STOP;
        }
        if (button !== 1)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        this._beginPress(px, py);
        return Clutter.EVENT_STOP;
    }

    _onTouch(event) {
        if (!this._enabled)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            const [px, py] = event.get_coords();
            this._beginPress(px, py);
            this._gazeAt(px, py);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _beginPress(px, py) {
        this._cancelSingleClick();
        this._pressed = true;
        this._dragging = false;
        this._pressPointerX = px;
        this._pressPointerY = py;
        this._pressActorX = this._x;
        this._pressActorY = this._y;
        this._pressAt = this._now;
        this._dragVX = 0;
        this._dragVY = 0;
        this._lastPointerX = px;
        this._lastPointerY = py;
        this._hasPointer = true;
        this._connectDragEvents();
        this._noteInteraction();
        this._gazeAt(px, py);
    }

    _connectDragEvents() {
        if (this._dragEventId !== null)
            return;
        this._dragEventId = global.stage.connect('captured-event',
            (_stage, event) => this._onDragEvent(event));
    }

    _disconnectDragEvents() {
        if (this._dragEventId !== null) {
            global.stage.disconnect(this._dragEventId);
            this._dragEventId = null;
        }
    }

    _onDragEvent(event) {
        if (!this._pressed)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.MOTION) {
            const [px, py] = event.get_coords();
            return this._onPressMove(px, py);
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            const [px, py] = event.get_coords();
            this._finishPress(px, py, false);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.TOUCH_UPDATE) {
            const [px, py] = event.get_coords();
            return this._onPressMove(px, py);
        }
        if (type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL) {
            const [px, py] = event.get_coords();
            this._finishPress(px, py, true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onPressMove(px, py) {
        const dist = Math.hypot(px - this._pressPointerX, py - this._pressPointerY);
        if (!this._dragging && dist > this._dragSlop) {
            this._dragging = true;
            this._bubbleVisible = false;
            this._bubble.hide();
            this._bubble.opacity = 0;
            this._active = null;
            this._refreshState(true);
            this._refreshVisual();
        }
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        const nx = this._pressActorX + px - this._pressPointerX;
        const ny = this._pressActorY + py - this._pressPointerY;
        [this._x, this._y] = this._clampPosition(nx, ny);
        this._dragVX = this._dragVX * 0.65 + (px - this._lastPointerX) * 0.35;
        this._dragVY = this._dragVY * 0.65 + (py - this._lastPointerY) * 0.35;
        this._lastPointerX = px;
        this._lastPointerY = py;
        this._placeActor();
        this._gazeAt(px, py);
        return Clutter.EVENT_STOP;
    }

    _finishPress(px, py, isTouch) {
        if (!this._pressed)
            return;
        this._now = nowMs();
        this._pressed = false;
        this._disconnectDragEvents();
        if (this._dragging) {
            this._dragging = false;
            this._savePosition();
            this._noteInteraction();
            this._startAction({
                expression: Math.random() < 0.5 ? 'happy' : 'curious',
                duration: 2,
                priority: PRIORITY.interaction,
                bounce: true,
                state: 'interaction',
                say: 'dragEnd',
                sayForce: true,
            });
            this._nextBehaviorAt = this._now + 2500;
            this._refreshState(true);
            return;
        }

        const dt = this._now - this._pressAt;
        if (isTouch && dt > 700)
            return;
        this._handleTap(px, py);
    }

    _handleTap(px, py) {
        const now = this._now;
        const isDouble = now - this._lastTapTime < 320 &&
            Math.hypot(px - this._lastTapX, py - this._lastTapY) < 30;
        if (isDouble) {
            this._lastTapTime = 0;
            this._cancelSingleClick();
            this._onDoubleClick();
            return;
        }
        this._lastTapTime = now;
        this._lastTapX = px;
        this._lastTapY = py;
        this._cancelSingleClick();
        this._singleClickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
            this._singleClickTimeoutId = null;
            this._onSingleClick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSingleClick() {
        if (this._singleClickTimeoutId !== null) {
            GLib.Source.remove(this._singleClickTimeoutId);
            this._singleClickTimeoutId = null;
        }
    }

    _onSingleClick() {
        if (!this._enabled || !this._actor || this._dragging)
            return;
        this._noteInteraction();
        let index = Math.floor(Math.random() * CLICK_REACTIONS.length);
        if (index === this._lastClickReaction)
            index = (index + 1) % CLICK_REACTIONS.length;
        this._lastClickReaction = index;
        const reaction = CLICK_REACTIONS[index];
        this._startAction({
            ...reaction,
            priority: PRIORITY.interaction,
            state: 'interaction',
            say: 'click',
            sayForce: true,
        });
        this._refreshState(true);
    }

    _onDoubleClick() {
        if (!this._enabled || !this._actor)
            return;
        this._noteInteraction();
        this._startAction({
            expression: 'laughing',
            duration: 2.8,
            priority: PRIORITY.interaction,
            state: 'interaction',
            bounce: true,
            hearts: true,
            say: 'doubleClick',
            sayForce: true,
        });
        this._refreshState(true);
    }

    _noteInteraction() {
        this._now = nowMs();
        this._lastInteraction = this._now;
        this._idleMood = null;
        if (this._state === 'bored' || this._state === 'sleepy')
            this._refreshState(true);
    }

    // ── Tick / state machine ──────────────────────────────────────────
    _startTick() {
        if (this._tickId !== null || !this._enabled || this._suspended)
            return;
        const interval = this._reducedMotion ? REDUCED_TICK_MS : TICK_MS;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            if (!this._enabled || this._suspended || !this._actor) {
                this._tickId = null;
                return GLib.SOURCE_REMOVE;
            }
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickId !== null) {
            GLib.Source.remove(this._tickId);
            this._tickId = null;
        }
    }

    _restartTick() {
        this._stopTick();
        this._startTick();
    }

    _tick() {
        this._now = nowMs();
        const dt = Math.min(0.12, (this._now - this._lastTick) / 1000);
        this._lastTick = this._now;

        this._updatePointer();
        this._refreshState(false);
        this._updateBehavior();
        this._updateGaze(dt);
        this._updateBlink();
        this._updateMotion(dt);
        this._updateSpeech();
        this._updateBubble();
    }

    setTimer(phase, running, remaining) {
        if (this._destroyed)
            return;
        const changed = phase !== this._phase || running !== this._running;
        this._phase = phase;
        this._running = running;
        this._remaining = remaining;
        this._focusRunning = running && phase === 'focus';

        if (this._focusRunning && remaining <= 10 && !this._nearEndNotified) {
            this._nearEndNotified = true;
            this._startAction({
                expression: 'determined',
                duration: 2.4,
                priority: PRIORITY.context,
                state: 'studying',
                say: 'focusNearEnd',
                sayChance: 0.55,
            });
        } else if (remaining > 12) {
            this._nearEndNotified = false;
        }

        if (changed) {
            this._nextBehaviorAt = this._now + rand(900, 2200);
            this._nextSpeechAt = this._now + this._speechDelay();
            if (!running && this._active && this._active.priority <= PRIORITY.context)
                this._active = null;
            this._refreshState(true);
        }
    }

    onFocusStart() {
        if (this._destroyed || !this._enabled)
            return;
        this._now = nowMs();
        this._lastInteraction = this._now;
        this._nearEndNotified = false;
        this._startAction({
            expression: 'determined',
            duration: 3,
            priority: PRIORITY.interaction,
            state: 'studying',
            say: 'focusStart',
            sayForce: true,
        });
        this._nextSpeechAt = this._now + this._speechDelay();
        this._refreshState(true);
    }

    onFocusComplete(isLong) {
        if (this._destroyed || !this._enabled)
            return;
        this._now = nowMs();
        this._lastInteraction = this._now;
        this._celebratingUntil = this._now + 6000;
        this._startAction({
            expression: Math.random() < 0.35 ? 'laughing' : 'excited',
            duration: 5.2,
            priority: PRIORITY.celebration,
            state: 'celebrating',
            bounce: true,
            hearts: true,
            say: isLong ? 'longBreak'
                : (Math.random() < 0.5 ? 'breakStart' : 'celebration'),
            sayForce: true,
        });
        this._refreshState(true);
        this._nextSpeechAt = this._now + this._speechDelay();
    }

    onBreakComplete() {
        if (this._destroyed || !this._enabled)
            return;
        this._now = nowMs();
        this._lastInteraction = this._now;
        this._startAction({
            expression: 'smiling',
            duration: 3,
            priority: PRIORITY.interaction,
            state: 'interaction',
            say: 'breakEnd',
            sayForce: true,
        });
        this._nextSpeechAt = this._now + this._speechDelay();
        this._refreshState(true);
    }

    onTimerReset() {
        this._active = null;
        this._celebratingUntil = 0;
        this._nearEndNotified = false;
        this._nextBehaviorAt = this._now + 1500;
        this._refreshState(true);
    }

    _speechDelay() {
        const style = styleFor(this._state);
        let base;
        if (this._focusRunning)
            base = rand(90000, 180000);
        else if (this._running)
            base = rand(60000, 110000);
        else if (this._state === 'bored' || this._state === 'sleepy')
            base = rand(50000, 95000);
        else
            base = rand(45000, 90000);
        return base * style.talk;
    }

    _computeState() {
        if (this._celebratingUntil > this._now)
            return 'celebrating';
        if (this._dragging)
            return 'dragged';
        if (this._active && this._now < this._active.end &&
            this._active.priority >= PRIORITY.interaction &&
            this._active.state)
            return this._active.state;
        if (this._sulking)
            return 'grumpy';
        if (this._running)
            return this._phase === 'focus' ? 'studying' : 'resting';

        const idle = this._now - this._lastInteraction;
        if (idle > 300000)
            this._idleMood = 'ignored';
        else if (idle > 150000)
            this._idleMood = 'sleepy';
        else if (idle > 75000)
            this._idleMood = 'bored';
        else if (idle > 30000)
            this._idleMood = 'curious';
        else
            this._idleMood = null;
        return this._idleMood ?? 'idle';
    }

    _refreshState(force) {
        const next = this._computeState();
        if (!force && next === this._state)
            return;
        const changed = next !== this._state;
        this._state = next;
        if (changed) {
            if (this._active && this._active.priority <= PRIORITY.context)
                this._active = null;
            this._nextBehaviorAt = this._now + rand(1400, 3200);
            this._nextSpeechAt = this._now + this._speechDelay();
            this._nextSaccadeAt = this._now + rand(400, 1400);
            if (!this._blinkActive)
                this._scheduleNextBlink();
        }
        this._refreshVisual();
    }

    _refreshVisual() {
        if (!this._actor)
            return;
        let expression = this._active?.expression;
        if (!expression)
            expression = STATE_EXPRESSION[this._state] ?? 'neutral';
        const base = EXPRESSIONS[expression] ?? EXPRESSIONS.neutral;

        const visual = {...base};
        const active = this._active;
        if (active) {
            if (active.mouth)
                visual.mouth = active.mouth;
            if (active.lid)
                visual.lid = active.lid;
            if (active.head !== undefined)
                visual.head = active.head;
            if (active.blush !== undefined)
                visual.blush = active.blush;
            if (active.hearts !== undefined)
                visual.hearts = active.hearts;
            if (active.brow !== undefined)
                visual.brow = active.brow;
        }
        visual.gazeX = active?.gazeX ?? base.gazeX ?? null;
        visual.gazeY = active?.gazeY ?? base.gazeY ?? null;
        visual.gazeTimer = !!active?.gazeTimer;
        visual.gazeUser = !!active?.gazeUser;
        visual.scale = active?.scale ?? 1;
        this._visual = visual;

        if (this._sulking)
            return;
        this._applyMouth(visual.mouth);
        this._applyBrows(visual.brow ?? 'neutral');
        if (!this._blinkActive)
            this._applyLids(visual.lid);
        this._applyHearts(visual.hearts);
    }

   _applyBrows(name) {
       if (!this._brows)
           return;
       const icon = this._icons[`brow-${name}`] ?? this._icons['brow-neutral'];
       if (icon) {
           this._brows.gicon = icon;
           this._browName = name;
       }
   }

   _applyMouth(name) {
        if (!this._mouth || this._mouthName === name)
            return;
        this._mouthName = name;
        const icon = this._icons[`mouth-${name}`] ?? this._icons['mouth-neutral'];
        if (!icon) {
            log('[Mochi] Missing mouth icon: ' + name);
            return;
        }
        this._mouth.gicon = icon;
    }

    _applyLids(state) {
        if (!this._lidLeft || !this._lidRight)
            return;
        this._lidState = state;
        if (state === 'open') {
            this._lidLeft.hide();
            this._lidRight.hide();
            return;
        }
        let lid = 'half';
        if (state === 'happy')
            lid = 'happy';
        else if (state === 'closed')
            lid = 'closed';
        else if (state === 'three-quarter')
            lid = this._icons['lid-left-three-quarter'] ? 'three-quarter' : 'half';
        else if (state === 'quarter')
            lid = this._icons['lid-left-quarter'] ? 'quarter' : 'half';
        const leftIcon = this._icons[`lid-left-${lid}`];
        const rightIcon = this._icons[`lid-right-${lid}`];
        if (!leftIcon || !rightIcon) {
            log('[Mochi] Missing lid icons for: ' + lid);
            return;
        }
        this._lidLeft.gicon = leftIcon;
        this._lidRight.gicon = rightIcon;
        this._lidLeft.show();
        this._lidRight.show();
        this._lidLeft.opacity = 255;
        this._lidRight.opacity = 255;
    }

    _applyHearts(show) {
        if (!this._hearts)
            return;
        this._heartsTarget = show ? 255 : 0;
    }

    // ── Autonomous behaviour scheduler ────────────────────────────────
    _updateBehavior() {
        const now = this._now;
        if (this._dragging || this._sulking || this._state === 'celebrating') {
            if (this._active && this._active.priority <= PRIORITY.drag)
                this._active = null;
            return;
        }

        if (this._active && now >= this._active.end) {
            this._active = null;
            this._refreshVisual();
            if (!this._running)
                this._nextBehaviorAt = now + rand(1800, 4500);
            else
                this._nextBehaviorAt = now + rand(1200, 3200);
        }

        if (this._active || now < this._nextBehaviorAt)
            return;

        const pool = BEHAVIORS[this._state] ?? BEHAVIORS.idle;
        const candidates = [];
        for (const behavior of pool) {
            const until = this._cooldowns.get(behavior.id) ?? 0;
            if (behavior.id === 'shy-glance' && !this._expressiveMode)
                continue;
            if (now >= until)
                candidates.push(behavior);
        }
        if (candidates.length === 0) {
            this._nextBehaviorAt = now + rand(3000, 6000);
            return;
        }

        const behavior = pickWeighted(candidates);
        const duration = rand(behavior.duration[0], behavior.duration[1]);
        const priority = this._state === 'studying' || this._state === 'resting'
            ? PRIORITY.context : PRIORITY.micro;
        this._startAction({
            expression: behavior.expression,
            mouth: behavior.mouth,
            lid: behavior.lid,
            head: behavior.head,
            gazeX: behavior.gazeX,
            gazeY: behavior.gazeY,
            gazeTimer: behavior.gazeTimer,
            gazeUser: behavior.gazeUser,
            bounce: behavior.bounce,
            hearts: behavior.hearts,
            scale: behavior.scale,
            duration,
            priority,
            state: this._state,
            say: behavior.say,
            sayChance: behavior.sayChance,
        });
        this._cooldowns.set(behavior.id, now + behavior.cool * 1000);
        this._nextBehaviorAt = now + duration * 1000 + rand(behavior.gap[0], behavior.gap[1]) * 1000;
    }

    _startAction(action) {
        if (!this._actor || this._destroyed)
            return false;
        const now = this._now;
        const active = this._active;
        if (active && now < active.end && action.priority < active.priority)
            return false;
        const duration = Math.max(0.5, action.duration ?? 2);
        this._active = {
            ...action,
            start: now,
            end: now + duration * 1000,
        };
        if (action.bounce)
            this._bounceStart = now;
        if (action.say && Math.random() < (action.sayChance ?? 1))
            this._sayPool(action.say, action.sayForce ?? false, action.saySeconds ?? 4);
        this._refreshVisual();
        return true;
    }

    // ── Eye tracking ──────────────────────────────────────────────────
    _gazeAt(px, py) {
        const dx = (px - this._faceX) / 300;
        const dy = (py - this._faceY) / 220;
        this._gazeTargetX = clamp(dx, -0.82, 0.82);
        this._gazeTargetY = clamp(dy, -0.72, 0.72);
        this._gazeHoldUntil = this._now + 1200;
    }

    _gazeDirectionTo(px, py, scale = 300) {
        const dx = (px - this._faceX) / scale;
        const dy = (py - this._faceY) / (scale * 0.72);
        return [clamp(dx, -1, 1), clamp(dy, -1, 1)];
    }

    _updateGaze(dt) {
        if (!this._enabled || this._sulking || this._dragging)
            return;

        const style = styleFor(this._state);
        const eyeBehavior = EYE_BEHAVIOR[this._state] ?? EYE_BEHAVIOR.idle;
        let tx = null;
        let ty = null;
        if (this._visual.gazeTimer) {
            const pos = this._options?.getTimerPosition?.();
            if (pos)
                [tx, ty] = this._gazeDirectionTo(pos[0], pos[1], 380);
            else
                [tx, ty] = [0.75, -1];
            this._gazeHoldUntil = this._now + 900;
        } else if (this._visual.gazeUser) {
            const [px, py] = global.get_pointer();
            [tx, ty] = this._gazeDirectionTo(px, py, 320);
        } else if (this._active?.gazeX !== undefined || this._active?.gazeY !== undefined) {
            tx = this._active.gazeX ?? 0;
            ty = this._active.gazeY ?? 0;
        } else if (this._now < (this._gazeHoldUntil ?? 0)) {
            const near = this._pointerNearFace();
            if (near) {
                const [px, py] = global.get_pointer();
                [tx, ty] = this._gazeDirectionTo(px, py);
            }
        } else if (this._reducedMotion) {
            tx = style.biasX;
            ty = style.biasY;
        } else if (this._pointerNearFace()) {
            const [px, py] = global.get_pointer();
            [tx, ty] = this._gazeDirectionTo(px, py);
        } else if (this._focusRunning && this._now >= this._nextTimerGlanceAt) {
            this._nextTimerGlanceAt = this._now + rand(7000, 14000);
            this._timerGlanceUntil = this._now + 1200;
            const pos = this._options?.getTimerPosition?.();
            if (pos)
                [tx, ty] = this._gazeDirectionTo(pos[0], pos[1], 380);
            else
                [tx, ty] = [0.7, -1];
        } else if (this._now < this._timerGlanceUntil) {
            const pos = this._options?.getTimerPosition?.();
            if (pos)
                [tx, ty] = this._gazeDirectionTo(pos[0], pos[1], 380);
            else
                [tx, ty] = [0.7, -1];
        } else if (this._now >= this._nextSaccadeAt) {
            // Use eye behavior saccade speed for more natural timing
            const saccadeInterval = rand(style.saccade[0], style.saccade[1]) / eyeBehavior.saccadeSpeed;
            this._nextSaccadeAt = this._now + saccadeInterval;
            const drift = style.drift;
            this._saccadeX = clamp(style.biasX + rand(-drift, drift), -1, 1);
            this._saccadeY = clamp(style.biasY + rand(-drift * 0.7, drift * 0.7), -1, 1);
            tx = this._saccadeX;
            ty = this._saccadeY;
        }

        if (tx === null) {
            if (this._visual.gazeX !== null || this._visual.gazeY !== null) {
                tx = this._visual.gazeX ?? 0;
                ty = this._visual.gazeY ?? 0;
            } else {
                tx = this._saccadeX + style.biasX * 0.35;
                ty = this._saccadeY + style.biasY;
            }
        }

        this._gazeTargetX = clamp(tx ?? 0, -0.58, 0.58);
        this._gazeTargetY = clamp(ty ?? 0, -0.45, 0.45);

        // Smoother gaze tracking with configurable speed
        const gazeAlpha = 1 - Math.pow(0.002 / eyeBehavior.saccadeSpeed, dt);
        this._gazeX = lerp(this._gazeX, this._gazeTargetX, gazeAlpha);
        this._gazeY = lerp(this._gazeY, this._gazeTargetY, gazeAlpha);

        // Pupils
        const fullyClosed = this._blinkActive && this._blinkFrame === 'closed';
        this._irisScale = fullyClosed ? 0 : lerp(this._irisScale ?? 1, this._pupilTarget(), 0.06);

        if (this._irisLeft) {
            const L = this._layout;
            const gx = this._reducedMotion ? 0 : this._gazeX * L.gazeX;
            const gy = this._reducedMotion ? 0 : this._gazeY * L.gazeY;
            this._irisLeft.translation_x = gx;
            this._irisLeft.translation_y = gy;
            this._irisRight.translation_x = gx;
            this._irisRight.translation_y = gy;
            const s = this._reducedMotion && !fullyClosed ? 1 : this._irisScale;
            this._irisLeft.scale_x = s;
            this._irisLeft.scale_y = s;
            this._irisRight.scale_x = s;
            this._irisRight.scale_y = s;
        }

        // Squint effect for certain states (focused, suspicious, bright light simulation)
        const squintAmount = eyeBehavior.squint ?? 0;
        if (squintAmount > 0 && !this._blinkActive && this._visual.lid !== 'closed') {
            const squintLid = squintAmount > 0.25 ? 'quarter' : 'half';
            this._applyLids(squintLid);
        }
    }

    _pupilTarget() {
        if (this._blinkActive && (this._blinkFrame === 'closed' || this._blinkFrame === 'three-quarter'))
            return 0;

        const eyeBehavior = EYE_BEHAVIOR[this._state] ?? EYE_BEHAVIOR.idle;
        let target = eyeBehavior.pupilBase;

        // Dynamic pupil based on expression
        const expr = this._active?.expression ?? this._visual?.expression;
        if (expr === 'surprised' || expr === 'excited' || this._visual.hearts) {
            target = Math.max(target, 1.07);
        } else if (expr === 'suspicious') {
            target = Math.min(target, 0.9);
        } else if (expr === 'sleepy' || expr === 'tired') {
            target = Math.min(target, 0.88);
        }

        // Pupil dilation when looking at something interesting (pointer/timer)
        const gazeActive = this._visual.gazeUser || this._visual.gazeTimer;
        if (gazeActive) {
            target += eyeBehavior.pupilRange * 0.5;
        }

        // Micro-dilation on interaction
        if (this._now - this._lastInteraction < 1000) {
            target += 0.05;
        }

        return clamp(target, 0.8, 1.15);
    }

    _pointerNearFace() {
        const [px, py] = global.get_pointer();
        const radius = Math.max(260, this._display * 1.5);
        return Math.hypot(px - this._faceX, py - this._faceY) < radius;
    }

    _updatePointer() {
        if (!this._enabled)
            return;
        const [px, py] = global.get_pointer();
        const L = this._layout;
        const inside = px >= this._x + L.hitX &&
            px <= this._x + L.hitX + L.hitW &&
            py >= this._y + L.stageY &&
            py <= this._y + L.stageY + L.display;
        const now = this._now;

        if (inside != this._wasInside) {
            this._wasInside = inside;
            if (inside) {
                this._noteInteraction();
                this._strokeDist = 0;
                this._strokeStart = now;
            }
        }

        if (!this._hasPointer) {
            this._hasPointer = true;
            this._lastPointerX = px;
            this._lastPointerY = py;
        }

        if (inside && !this._dragging) {
            if (now - this._strokeStart > PET_WINDOW_MS) {
                this._strokeStart = now;
                this._strokeDist = 0;
            }
            this._strokeDist += Math.hypot(px - this._lastPointerX, py - this._lastPointerY);
            if (this._strokeDist >= PET_DISTANCE && now - this._lastPet > PET_COOLDOWN_MS)
                this._pet(now);
        } else if (!inside) {
            this._strokeDist = 0;
        }

        this._lastPointerX = px;
        this._lastPointerY = py;
    }

    // ── Blink ─────────────────────────────────────────────────────────
    _updateBlink() {
        if (!this._actor || this._sulking)
            return;
        const now = this._now;

        if (!this._blinkActive) {
            if (this._blinkDoubleAt && now >= this._blinkDoubleAt) {
                this._blinkDoubleAt = 0;
                this._startBlink('fast');
                return;
            }
            if (now >= this._nextBlinkAt)
                this._startBlink();
            return;
        }

        if (now < this._blinkNextAt)
            return;

        const frames = this._blinkFrames;
        this._blinkIndex += 1;
        if (this._blinkIndex >= frames.length) {
            this._blinkActive = false;
            this._blinkFrames = null;
            this._blinkFrame = 'open';
            this._applyLids(this._visual.lid);
            this._scheduleNextBlink();
            return;
        }
        const [ms, lid] = frames[this._blinkIndex];
        this._blinkFrame = lid;
        this._blinkNextAt = now + ms;
        if (lid === 'closed') {
            this._irisScale = 0;
            if (this._irisLeft) {
                this._irisLeft.scale_x = 0;
                this._irisLeft.scale_y = 0;
                this._irisRight.scale_x = 0;
                this._irisRight.scale_y = 0;
            }
        }
        this._applyLids(lid);
    }

    _startBlink(kind = null) {
        let type = kind;
        if (!type) {
            const eyeBehavior = EYE_BEHAVIOR[this._state] ?? EYE_BEHAVIOR.idle;
            type = eyeBehavior.blinkStyle;
            // Occasional variation
            if (type === 'normal' && Math.random() < 0.1) {
                type = ['fast', 'slow', 'micro'][Math.floor(Math.random() * 3)];
            } else if (type === 'soft' && Math.random() < 0.15) {
                type = 'dreamy';
            } else if (type === 'slow' && Math.random() < 0.1) {
                type = 'tired';
            }
        }
        const frames = BLINK_FRAMES[type] ?? BLINK_FRAMES.normal;
        this._blinkActive = true;
        this._blinkFrames = frames;
        this._blinkIndex = 0;
        this._blinkFrame = frames[0][1];
        this._blinkNextAt = this._now + frames[0][0];
        this._applyLids(frames[0][1]);
    }

    _scheduleNextBlink() {
        const style = styleFor(this._state);
        const [lo, hi] = style.blink;
        this._nextBlinkAt = this._now + rand(lo, hi);
        if (Math.random() < 0.12)
            this._blinkDoubleAt = this._nextBlinkAt + 260;
        else
            this._blinkDoubleAt = 0;
    }

    // ── Motion ────────────────────────────────────────────────────────
    _updateMotion(dt) {
        if (!this._actor || !this._stage)
            return;
        const now = this._now;
        const seconds = (now - this._t0) / 1000;
        const reduce = this._reducedMotion;
        const visual = this._visual;
        const S = this._display / SIZES.medium;

        let hx = 0;
        let hy = 0;
        let rot = visual.head ?? 0;
        let bodyScale = 1;
        let stageX = 0;
        let stageY = 0;

        if (!this._sulking) {
            const style = styleFor(this._state);
            if (!reduce) {
                const breath = Math.sin(seconds * 2 * Math.PI / style.breath);
                bodyScale = 1 + breath * 0.006;
                hy += breath * 0.8;
                rot += Math.sin(seconds * 2 * Math.PI / 7.3) * style.sway * 0.5;
                hx += Math.sin(seconds * 2 * Math.PI / 5.1) * style.sway;
            }
            rot += style.lean;
            hy += style.lift;
            if (this._state === 'resting' && !reduce)
                rot += Math.sin(seconds * 2 * Math.PI / 9.1) * 0.32;

            const active = this._active;
            if (active && now < active.end) {
                const t = clamp((now - active.start) / (active.end - active.start), 0, 1);
                const ease = 1 - Math.pow(1 - t, 3);
                // `visual.head` already carries the active override; do not add it
                // again here or behaviours would tilt twice.
                hy += 0.6 * ease;
            }

            const bounceT = (now - this._bounceStart) / 700;
            if (!reduce && bounceT >= 0 && bounceT < 1) {
                const e = 1 - bounceT;
                stageY -= Math.abs(Math.sin(bounceT * Math.PI * 2)) * 11 * e;
                rot += Math.sin(bounceT * Math.PI * 4) * 1.2 * e;
            }

            if (this._dragging) {
                rot += clamp(-this._dragVX * 0.35, -4, 4);
                hx += clamp(this._dragVX * 0.15, -1.5, 1.5);
                stageY += clamp(-this._dragVY * 0.2, -3, 3);
            } else {
                rot += this._gazeX * 0.65;
                hx += this._gazeX * 1.1;
                hy += this._gazeY * 0.55;
            }
        } else {
            const since = now - this._sulkStart;
            if (since < 900)
                stageX = Math.sin(since * 0.07) * 4 * (1 - since / 900);
            stageY = 1;
            bodyScale = 1;
        }

        const smooth = this._reducedMotion ? 1 : 1 - Math.pow(0.0005, dt);
        this._headX = lerp(this._headX, hx, smooth);
        this._headY = lerp(this._headY, hy, smooth);
        this._headRot = lerp(this._headRot, rot, smooth);
        this._bodyScale = lerp(this._bodyScale, bodyScale, smooth);

        let browTarget = 0;
        if (!reduce) {
            if (this._browName === 'shy')
                browTarget = Math.sin(seconds * 2.2) * 0.8 - 0.5;
            else if (this._browName === 'angry')
                browTarget = Math.sin(seconds * 3.1) * 0.35;
            else if (this._browName === 'confused')
                browTarget = Math.sin(seconds * 1.8) * 0.6;
        }
        this._browY = lerp(this._browY, browTarget, smooth);
        if (this._brows)
            this._brows.translation_y = this._browY * S;

        this._headGroup.translation_x = this._headX * S;
        this._headGroup.translation_y = this._headY * S;
        this._headGroup.rotation_angle_z = this._headRot;
        this._headGroup.scale_x = reduce ? 1 : 1 + (this._bodyScale - 1) * 0.35;
        this._headGroup.scale_y = reduce ? 1 : this._bodyScale;
        this._stage.translation_x = stageX * S;
        this._stage.translation_y = stageY * S;

        if (visual.scale && visual.scale !== 1 && !reduce && !this._sulking)
            this._stage.scale_y = lerp(this._stage.scale_y, visual.scale, 0.08);
        else
            this._stage.scale_y = lerp(this._stage.scale_y, 1, 0.08);

        const blushTarget = Math.round((visual.blush ?? 0) * 255);
        if (this._blush) {
            const blush = Math.round(lerp(this._blush.opacity, blushTarget, 0.12));
            if (blush !== this._blush.opacity)
                this._blush.opacity = blush;
        }
        if (this._hearts) {
            const heartsTarget = this._heartsTarget ?? 0;
            const hearts = Math.round(lerp(this._hearts.opacity, heartsTarget, 0.12));
            if (hearts !== this._hearts.opacity)
                this._hearts.opacity = hearts;
            if (!reduce && this._hearts.opacity > 4)
                this._hearts.translation_y = Math.sin(seconds * 1.7) * 1.8;
        }
    }

    // ── Speech bubble ─────────────────────────────────────────────────
    _pickDialogue(pool) {
        const list = DIALOGUE[pool];
        if (!list || list.length === 0)
            return null;
        const available = list.filter(text => !this._recentTexts.includes(text));
        const source = available.length ? available : list;
        return source[Math.floor(Math.random() * source.length)];
    }

    _sayPool(pool, force = false, seconds = 4) {
        const text = this._pickDialogue(pool);
        if (text)
            this.say(text, seconds, force);
    }

    say(text, seconds = 4, force = false) {
        if (!this._enabled || !this._bubble || !this._actor)
            return;
        const now = this._now;
        if (!force && now < this._bubbleCooldownUntil)
            return;
        if (force && now - this._lastBubbleAt < 1200)
            return;
        this._bubbleCooldownUntil = now + 2400;
        this._lastBubbleAt = now;
        this._bubble.text = text;
        this._bubbleVisible = true;
        this._bubbleHideAt = now + Math.max(2, seconds) * 1000;
        this._bubble.show();
        if (this._bubble.opacity < 10)
            this._bubble.opacity = 0;
        this._recentTexts.push(text);
        if (this._recentTexts.length > 10)
            this._recentTexts.shift();
        this._placeBubble();
    }

    _updateSpeech() {
        if (!this._actor || this._sulking)
            return;
        if (this._now < this._nextSpeechAt)
            return;
        if (this._dragging || this._state === 'celebrating')
            return;
        let pool = 'idle';
        if (this._state === 'studying')
            pool = 'studying';
        else if (this._state === 'resting')
            pool = 'breakIdle';
        else if (this._state === 'bored')
            pool = 'bored';
        else if (this._state === 'sleepy')
            pool = 'sleepy';
        else if (this._state === 'ignored')
            pool = 'ignored';
        else if (this._state === 'curious')
            pool = 'idle';
        this._sayPool(pool, false, 4);
        this._nextSpeechAt = this._now + this._speechDelay();
    }

    _placeBubble() {
        if (!this._bubble || !this._actor || !this._bubbleVisible)
            return;
        const monitor = this._monitor();
        if (!monitor)
            return;
        const bw = this._layout.bubbleW;
        let bh = 40;
        try {
            bh = this._bubble.get_preferred_height(bw)[1];
        } catch (e) {
            // Label not allocated yet; keep a safe default.
        }
        const top = monitor.y + Main.panel.height;
        let sx = this._x + (this._layout.w - bw) / 2;
        let sy = this._y + this._layout.stageY - bh - 6;
        sx = clamp(sx, monitor.x + 4, monitor.x + monitor.width - bw - 4);
        sy = clamp(sy, top + 4, monitor.y + monitor.height - bh - 4);
        // Keep the label inside the actor; children may render outside, but a
        // negative local position makes debugging/drag bounds confusing.
        sy = Math.max(sy, this._y + 4);
        this._bubble.set_position(Math.round(sx - this._x), Math.round(sy - this._y));
        this._bubble.set_width(bw);
    }

    _updateBubble() {
        if (!this._bubble)
            return;
        const visible = this._bubbleVisible && this._now < this._bubbleHideAt;
        const target = visible ? 255 : 0;
        const current = this._bubble.opacity;
        const next = Math.round(current + (target - current) * 0.28);
        if (next !== current)
            this._bubble.opacity = next;
        if (!visible) {
            if (next <= 2) {
                if (this._bubble.visible)
                    this._bubble.hide();
                this._bubble.opacity = 0;
                this._bubbleVisible = false;
            }
        }
    }

    // ── Petting / sulk (existing behaviour preserved) ─────────────────
    _pet(now) {
        this._lastPet = now;
        this._strokeDist = 0;
        this._strokeStart = now;
        this._options?.onPet?.();
        this._noteInteraction();

        if (now - this._petStreakAt < 7000)
            this._petStreak = Math.min(3, this._petStreak + 1);
        else
            this._petStreak = 1;
        this._petStreakAt = now;

        if (this._sulking) {
            this._petsSinceSulk += 1;
            if (this._petsSinceSulk >= 2)
                this._forgive(this._pickDialogue('forgive'));
            else
                this._sayPool('stillMad', true, 3);
            this._bounceStart = now;
            return;
        }

        this._bounceStart = now;
        let expression = 'happy';
        let duration = 2.5;
        if (this._expressiveMode && this._petStreak >= 2)
            expression = 'shy';
        if (this._expressiveMode && this._petStreak >= 3) {
            expression = 'adore';
            duration = 3.5;
        }
        this._startAction({
            expression,
            duration,
            priority: PRIORITY.interaction,
            state: 'interaction',
            bounce: true,
            say: expression === 'shy' ? 'shy' : 'pet',
            sayForce: true,
            sayChance: 0.85,
        });
        this._refreshState(true);
    }

    noteScroll() {
        if (!this._enabled || this._destroyed || this._suspended || !this._focusRunning)
            return;
        const sec = Math.floor(this._now / 1000);
        this._lastScrollSec = sec;
        if (this._scrollSecs[this._scrollSecs.length - 1] !== sec)
            this._scrollSecs.push(sec);
    }

    heartbeat(focusRunning) {
        if (!this._enabled || this._destroyed || this._suspended)
            return;
        this._focusRunning = focusRunning;
        const sec = Math.floor(this._now / 1000);
        if (!focusRunning) {
            this._scrollSecs.length = 0;
            if (this._sulking && sec - this._lastScrollSec > SULK_FORGIVE_DELAY_SEC)
                this._forgive(this._pickDialogue('forgive'));
            if (this._doomBlocking && sec - this._lastScrollSec > 60)
                this._dismissDoomBlocker();
            return;
        }
        const cutoff = sec - DOOM_SCROLL_WINDOW;
        while (this._scrollSecs.length && this._scrollSecs[0] < cutoff)
            this._scrollSecs.shift();

        // Doom scroll blocker: more aggressive than sulk
        if (!this._doomBlocking && !this._sulking && this._scrollSecs.length >= DOOM_SCROLL_THRESHOLD)
            this._showDoomBlocker();

        // Original sulk (less aggressive, after blocker dismissed)
        if (!this._sulking && this._scrollSecs.length >= 15)
            this._startSulk();

        if (this._sulking && sec - this._lastScrollSec > SULK_FORGIVE_DELAY_SEC)
            this._forgive(this._pickDialogue('forgive'));

        // Auto-dismiss blocker if user stops scrolling for a while
        if (this._doomBlocking && sec - this._lastScrollSec > 30)
            this._dismissDoomBlocker();
    }

    _startSulk() {
        if (this._sulking)
            return;
        this._sulking = true;
        this._sulkStart = this._now;
        this._petsSinceSulk = 0;
        this._scrollSecs.length = 0;
        this._options?.onSulk?.();
        this._active = null;
        this._blinkActive = false;
        this._blinkFrames = null;
        this._blinkFrame = 'open';
        this._applySulk(true);
        this._startAction({
            expression: 'grumpy',
            mouth: 'pout',
            lid: 'quarter',
            head: -2,
            brow: 'angry',
            gazeX: -0.55,
            gazeY: 0.15,
            duration: 120,
            priority: PRIORITY.interaction,
            state: 'grumpy',
        });
        this._sayPool('sulk', true, 6);
        this._refreshState(true);
    }

    _forgive(text) {
        if (!this._sulking)
            return;
        this._sulking = false;
        this._petsSinceSulk = 0;
        this._scrollSecs.length = 0;
        this._applySulk(false);
        this._blinkActive = false;
        this._blinkFrames = null;
        this._blinkFrame = 'open';
        this._nextBlinkAt = this._now + 700;
        this._bounceStart = this._now;
        this._startAction({
            expression: 'happy',
            duration: 2.5,
            priority: PRIORITY.interaction,
            state: 'interaction',
            bounce: true,
        });
        this.say(text ?? this._pickDialogue('forgive'), 4, true);
        this._refreshState(true);
    }

    _showDoomBlocker() {
        if (!this._doomBlockerActor || this._doomBlocking) return;
        const now = this._now;
        if (now - this._lastDoomBlockerAt < DOOM_BLOCKER_COOLDOWN) return;

        this._doomBlocking = true;
        this._doomBlockerStart = now;
        this._doomBlockerDismissed = false;
        this._lastDoomBlockerAt = now;

        // Stop current animations
        this._active = null;
        this._blinkActive = false;
        this._blinkFrames = null;
        this._blinkFrame = 'open';

        // Show blocker with animation
        this._doomBlockerActor.show();
        this._doomBlockerActor.opacity = 0;
        this._doomBlockerActor.opacity = 255; // instant show for now, could animate

        // Set angry expression
        if (this._doomCharMouth) this._doomCharMouth.gicon = this._icons['mouth-frown'];
        if (this._doomCharLidLeft) this._doomCharLidLeft.gicon = this._icons['lid-left-half'];
        if (this._doomCharLidRight) this._doomCharLidRight.gicon = this._icons['lid-right-half'];
        this._doomCharLidLeft.show();
        this._doomCharLidRight.show();

        // Angry dialogue from pool
        const text = this._pickDialogue('doomScroll');
        this._showDoomBubble(text);

        // Auto-dismiss after duration
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, DOOM_BLOCKER_DURATION, () => {
            if (this._doomBlocking && !this._doomBlockerDismissed) {
                this._dismissDoomBlocker();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _showDoomBubble(text) {
        if (!this._doomBubble) return;
        this._doomBubble.text = text;
        this._doomBubble.show();
        this._doomBubble.opacity = 0;
        // Fade in
        const fadeIn = () => {
            if (!this._doomBubble || this._doomBubble.opacity >= 255) return;
            this._doomBubble.opacity = Math.min(255, this._doomBubble.opacity + 30);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, fadeIn);
        };
        fadeIn();

        // Show hint after delay
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            if (this._doomHint && this._doomBlocking) {
                this._doomHint.show();
                this._doomHint.opacity = 0;
                const fadeHint = () => {
                    if (!this._doomHint || this._doomHint.opacity >= 255) return;
                    this._doomHint.opacity = Math.min(255, this._doomHint.opacity + 25);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, fadeHint);
                };
                fadeHint();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissDoomBlocker() {
        if (!this._doomBlocking || !this._doomBlockerActor) return;
        this._doomBlocking = false;
        this._doomBlockerDismissed = true;

        // Fade out
        const fadeOut = () => {
            if (!this._doomBlockerActor) return;
            if (this._doomBlockerActor.opacity <= 0) {
                this._doomBlockerActor.hide();
                this._doomBlockerActor.opacity = 0;
                if (this._doomBubble) {
                    this._doomBubble.hide();
                    this._doomBubble.opacity = 0;
                }
                if (this._doomHint) {
                    this._doomHint.hide();
                    this._doomHint.opacity = 0;
                }
                // Cheer up after dismiss
                this._bounceStart = this._now;
                this._startAction({
                    expression: 'happy',
                    duration: 2.5,
                    priority: PRIORITY.interaction,
                    state: 'interaction',
                    bounce: true,
                    say: 'pet',
                    sayForce: true,
                    sayChance: 0.8,
                });
                this._refreshState(true);
                return;
            }
            this._doomBlockerActor.opacity = Math.max(0, this._doomBlockerActor.opacity - 30);
            if (this._doomBubble) this._doomBubble.opacity = Math.max(0, this._doomBubble.opacity - 30);
            if (this._doomHint) this._doomHint.opacity = Math.max(0, this._doomHint.opacity - 30);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, fadeOut);
        };
        fadeOut();
    }

    _applySulk(on) {
        if (!this._headGroup || !this._sulk)
            return;
        // Keep the normal animated head/body visible. Switching to the
        // separate sulk artwork can make the character jump or turn into a
        // mismatched face, so it is intentionally not used.
        this._headGroup.visible = true;
        this._sulk.visible = false;
        if (on && this._hearts) {
            this._hearts.opacity = 0;
            this._heartsTarget = 0;
        }
    }

    // CHARACTER_BODY_ENDS
}



