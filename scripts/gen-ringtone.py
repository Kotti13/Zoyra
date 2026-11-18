#!/usr/bin/env python3
"""
Generates Zoyra's call tones (original, synthesized here, no samples, free of third-party rights):

  assets/sounds/zoyra_ring.wav      incoming ringtone, 3.0 s, loops seamlessly
                                    (CallKit ringtoneSound, Android call channel, in-app ring screen)
  assets/sounds/zoyra_ringback.wav  outgoing ringback for the caller while "Calling…", 3.0 s, loops

Format: 44.1 kHz, 16-bit PCM, mono. Every note has a soft attack and release and the loop
ends in silence, so looping never clicks. Peak is normalised to -3 dBFS (no clipping).

Run from the project root:  python3 scripts/gen-ringtone.py
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


def bell(freq: float, t: float, length: float) -> float:
    """A soft marimba / glass-bell voice: a few inharmonic-ish partials with their own decays."""
    partials = ((1.0, 1.0, 3.2), (2.0, 0.35, 5.0), (3.01, 0.12, 7.5), (4.2, 0.05, 10.0))
    s = 0.0
    for ratio, amp, decay in partials:
        s += amp * math.exp(-decay * t / max(length, 0.2)) * math.sin(2 * math.pi * freq * ratio * t)
    return s


def envelope(t: float, length: float, attack: float = 0.012, release: float = 0.08) -> float:
    if t < 0 or t > length:
        return 0.0
    a = min(1.0, t / attack) if attack > 0 else 1.0
    r = min(1.0, (length - t) / release) if release > 0 else 1.0
    # raised-cosine edges
    a = 0.5 - 0.5 * math.cos(math.pi * a)
    r = 0.5 - 0.5 * math.cos(math.pi * r)
    return a * r


def render(events, total_s: float, voice) -> list:
    n = int(total_s * RATE)
    buf = [0.0] * n
    for start, midi, length, gain in events:
        f = note_hz(midi)
        i0 = int(start * RATE)
        i1 = min(n, int((start + length) * RATE))
        for i in range(i0, i1):
            t = (i - i0) / RATE
            buf[i] += gain * envelope(t, length) * voice(f, t, length)
    return buf


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
        frames = b''.join(struct.pack('<h', max(-32767, min(32767, int(round(x * 32767))))) for x in buf)
        w.writeframes(frames)


def ring() -> list:
    # Two rising three-note phrases (E5 – G#5 – B5, then E5 – G#5 – E6), a breath, repeat.
    # 0.0 – 1.1 s phrase 1, 1.25 – 2.45 s phrase 2, 2.45 – 3.0 s decays to silence (loop point).
    E5, GS5, B5, E6 = 76, 80, 83, 88
    ev = [
        (0.00, E5, 0.45, 1.0),
        (0.18, GS5, 0.45, 0.9),
        (0.36, B5, 0.70, 0.85),
        (1.25, E5, 0.45, 1.0),
        (1.43, GS5, 0.45, 0.9),
        (1.61, E6, 0.80, 0.75),
    ]
    return normalise(render(ev, 3.0, bell))


def soft_tone(freq: float, t: float, _length: float) -> float:
    # Warm two-tone ringback (like a classic phone ringback, softened): fundamental + a fifth, gentle.
    return math.sin(2 * math.pi * freq * t) + 0.5 * math.sin(2 * math.pi * freq * 1.5 * t)


def ringback() -> list:
    # 1.0 s tone (A4 + E5 shimmer) with 2.0 s silence: the familiar "ring… ring…" cadence.
    buf = render([(0.0, 69, 1.0, 1.0)], 3.0, soft_tone)
    out = normalise(buf)
    return [x * 0.6 for x in out]  # ringback stays quieter than the ringtone (~ -7.4 dBFS)


if __name__ == '__main__':
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'sounds')
    write_wav(os.path.join(root, 'zoyra_ring.wav'), ring())
    write_wav(os.path.join(root, 'zoyra_ringback.wav'), ringback())
    print('wrote assets/sounds/zoyra_ring.wav and assets/sounds/zoyra_ringback.wav')
