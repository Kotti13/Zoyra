#!/usr/bin/env python3
"""
Generates Zoyra's "gold" Forever ringtone (original, synthesized here, no samples, free of third-party rights):

  assets/sounds/zoyra_gold_ring.wav   incoming call from a Forever friend, 4.0 s, loops seamlessly
                                      (expo-notifications `sounds` → iOS bundle + Android res/raw; picked by
                                      ringtoneFor() in src/lib/forever.ts and the push function for Forever calls)

Character: a bright celesta / glass-bell arpeggio rising through D major add9 (D6 F#6 A6 E7 → F#7), a sparkle
of high partials ("gold shimmer") and a warm low fifth underneath, then a breath. Distinct from zoyra_ring.wav
(E major marimba phrases) so a Forever call is recognisable without looking.

Format: 44.1 kHz, 16-bit PCM, mono. Soft attacks / releases, the loop ends in silence (no click).
Peak normalised to -3 dBFS.

Run from the project root:  python3 scripts/gen-gold-ringtone.py
Standard library only.
"""
import math
import os
import struct
import wave

RATE = 44100
PEAK = 10 ** (-3 / 20)  # -3 dBFS


def note_hz(midi: int) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def celesta(freq: float, t: float, length: float) -> float:
    """Glassy bell: strong fundamental, bright octave + a slightly sharp 'shimmer' partial with a slow beat."""
    partials = ((1.0, 1.0, 2.6), (2.0, 0.42, 4.2), (3.0, 0.16, 6.5), (4.07, 0.08, 9.0), (5.98, 0.04, 12.0))
    s = 0.0
    for ratio, amp, decay in partials:
        s += amp * math.exp(-decay * t / max(length, 0.2)) * math.sin(2 * math.pi * freq * ratio * t)
    # gold shimmer: a detuned twin of the 2nd partial, beating at ~6 Hz
    s += 0.18 * math.exp(-5.0 * t / max(length, 0.2)) * math.sin(2 * math.pi * (freq * 2.0 + 6.0) * t)
    return s


def pad(freq: float, t: float, length: float) -> float:
    """Warm low fifth with a gentle swell (sits under the bells)."""
    swell = math.sin(math.pi * min(1.0, t / max(length, 0.01)))
    return swell * (math.sin(2 * math.pi * freq * t) + 0.45 * math.sin(2 * math.pi * freq * 1.5 * t) + 0.2 * math.sin(2 * math.pi * freq * 2 * t))


def sparkle(freq: float, t: float, length: float) -> float:
    """Tiny high 'glint' pings (pure sine, very fast decay)."""
    return math.exp(-28.0 * t) * math.sin(2 * math.pi * freq * t)


def envelope(t: float, length: float, attack: float = 0.006, release: float = 0.12) -> float:
    if t < 0 or t > length:
        return 0.0
    a = min(1.0, t / attack) if attack > 0 else 1.0
    r = min(1.0, (length - t) / release) if release > 0 else 1.0
    a = 0.5 - 0.5 * math.cos(math.pi * a)
    r = 0.5 - 0.5 * math.cos(math.pi * r)
    return a * r


def render(buf: list, events, voice, attack: float = 0.006, release: float = 0.12) -> None:
    n = len(buf)
    for start, midi, length, gain in events:
        f = note_hz(midi) if isinstance(midi, int) else float(midi)
        i0 = int(start * RATE)
        i1 = min(n, int((start + length) * RATE))
        for i in range(i0, i1):
            t = (i - i0) / RATE
            buf[i] += gain * envelope(t, length, attack, release) * voice(f, t, length)


def normalise(buf: list) -> list:
    peak = max(1e-9, max(abs(x) for x in buf))
    k = PEAK / peak
    return [x * k for x in buf]


def write_wav(path: str, buf: list) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', max(-32767, min(32767, int(round(x * 32767))))) for x in buf))


def gold_ring() -> list:
    total = 4.0
    buf = [0.0] * int(total * RATE)
    D6, FS6, A6, E7, FS7, A5, D5 = 86, 90, 93, 100, 102, 81, 74
    # Phrase 1: rising arpeggio, the top note rings longer.
    bells = [
        (0.00, D6, 0.55, 0.95),
        (0.13, FS6, 0.55, 0.85),
        (0.26, A6, 0.60, 0.80),
        (0.39, E7, 0.60, 0.62),
        (0.52, FS7, 1.10, 0.70),
        # Phrase 2: answer, a third lower, resolving down to A6.
        (1.70, A6, 0.55, 0.85),
        (1.83, FS7, 0.55, 0.55),
        (1.96, E7, 0.60, 0.62),
        (2.09, D6 + 12, 0.60, 0.60),
        (2.22, A6, 1.20, 0.78),
    ]
    render(buf, bells, celesta)
    # Warm low fifth under each phrase.
    render(buf, [(0.0, D5 - 12, 1.5, 0.22), (1.7, A5 - 24, 1.6, 0.2)], pad, attack=0.08, release=0.5)
    # Glints between the notes (gold sparkle).
    glints = [(0.07, 3520.0, 0.18, 0.12), (0.33, 4186.0, 0.18, 0.10), (0.6, 4699.0, 0.2, 0.12), (1.78, 3951.0, 0.18, 0.10), (2.3, 4435.0, 0.2, 0.11)]
    render(buf, glints, sparkle, attack=0.002, release=0.05)
    # Loop point: last ~0.35 s are silence (everything above ends by ~3.45 s).
    return normalise(buf)


if __name__ == '__main__':
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'sounds')
    write_wav(os.path.join(root, 'zoyra_gold_ring.wav'), gold_ring())
    print('wrote assets/sounds/zoyra_gold_ring.wav')
