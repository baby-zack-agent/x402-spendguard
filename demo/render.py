#!/usr/bin/env python3
"""Programmatic renderer for the x402-spendguard v0.2.0 demo video.
Reads demo/shots.json (captured from the REAL cli/lib) and renders a
1080x1920, 30fps, silent mp4 with a premium dark+gold terminal aesthetic.
Brand: near-black #0C0B09, champagne gold #D4AF69.
"""
import json, os, math, textwrap
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1080, 1920
FPS = 30
DEMO = os.path.dirname(os.path.abspath(__file__))
FRAMES = '/tmp/sgdemo/frames'
OUT = os.path.join(DEMO, 'x402-spendguard-v0.2-demo.mp4')

BG = (12, 11, 9)
PANEL = (21, 19, 14)
PANEL_BD = (46, 39, 30)
GOLD = (212, 175, 105)
GOLD_DIM = (138, 110, 62)
TEXT = (236, 230, 216)
DIM = (141, 132, 116)
GREEN = (134, 192, 108)
RED = (228, 102, 90)

FD = '/usr/share/fonts/truetype/dejavu'
mono = ImageFont.truetype(f'{FD}/DejaVuSansMono.ttf', 30)
mono_b = ImageFont.truetype(f'{FD}/DejaVuSansMono-Bold.ttf', 30)
mono_s = ImageFont.truetype(f'{FD}/DejaVuSansMono.ttf', 26)
sans = ImageFont.truetype(f'{FD}/DejaVuSans.ttf', 58)
sans_b = ImageFont.truetype(f'{FD}/DejaVuSans-Bold.ttf', 78)
sans_m = ImageFont.truetype(f'{FD}/DejaVuSans.ttf', 40)
sans_s = ImageFont.truetype(f'{FD}/DejaVuSans.ttf', 34)
sans_xs = ImageFont.truetype(f'{FD}/DejaVuSans.ttf', 28)

CHAR_W = mono.getlength('0')
WRAP = int(920 / CHAR_W)  # chars per terminal line

TOKEN_COLORS = {'[ALLOW]': GREEN, '[DENIED]': RED, '[HELD]': GOLD}

# ---------- vignette (precomputed) ----------
def _vignette():
    v = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(v)
    for r in range(0, 900, 6):
        a = int(52 * (r / 900) ** 2)
        d.ellipse([W/2 - r, H/2 - r, W/2 + r, H/2 + r], outline=a, width=6)
    v = v.filter(ImageFilter.GaussianBlur(60))
    black = Image.new('RGB', (W, H), (0, 0, 0))
    return Image.composite(black, Image.new('RGB', (W, H), BG), v)
VIGNETTE = None

def base_canvas():
    global VIGNETTE
    if VIGNETTE is None:
        VIGNETTE = _vignette()
    return VIGNETTE.copy()

# ---------- text helpers ----------
def wrap(text, width=WRAP):
    tw = textwrap.TextWrapper(width=width, break_long_words=True,
                              break_on_hyphens=False, replace_whitespace=False,
                              drop_whitespace=True)
    out = []
    for para in text.split('\n'):
        out.extend(tw.wrap(para) or [''])
    return out

def colorize(line):
    """Split a line into (text, color) segments on [ALLOW]/[DENIED]/[HELD]."""
    segs, rest = [], line
    while rest:
        idx = [(rest.find(t), t) for t in TOKEN_COLORS if rest.find(t) != -1]
        if not idx:
            segs.append((rest, TEXT)); break
        i, tok = min(idx)
        if i > 0:
            segs.append((rest[:i], TEXT))
        segs.append((tok, TOKEN_COLORS[tok]))
        rest = rest[i + len(tok):]
    return segs

def draw_segs(d, x, y, segs, font):
    for txt, col in segs:
        d.text((x, y), txt, font=font, fill=col)
        x += font.getlength(txt)
    return x

def draw_cmd(d, x, y, body, lh, maxy, cursor=False):
    """Draw a `$ <cmd>` line, wrapping the body; returns (x_end, y_end)."""
    chunks = wrap(body, WRAP - 2) or ['']
    xe = draw_segs(d, x, y, [('$ ', GOLD), (chunks[0], TEXT)], mono_b)
    ye = y
    for ch in chunks[1:]:
        ye += lh
        if ye + lh > maxy:
            break
        xe = draw_segs(d, x, ye, [('  ', GOLD), (ch, TEXT)], mono_b)
    if cursor:
        d.rectangle([xe + 6, ye + 4, xe + 22, ye + 36], fill=GOLD)
    return xe, ye

def centered(d, y, text, font, fill):
    d.text((W / 2, y), text, font=font, fill=fill, anchor='mm')

# ---------- terminal screen ----------
class Screen:
    def __init__(self, eyebrow, caption):
        self.lines = []  # each: (kind, payload); kind in cmd/comment/segs
        self.eyebrow = eyebrow
        self.caption = caption

    def add_cmd(self, text):
        self.lines.append(('cmd', text))

    def add_comment(self, text):
        self.lines.append(('comment', text))

    def add_line(self, text):
        for w in wrap(text):
            self.lines.append(('segs', colorize(w)))

    def add_dim(self, text):
        for w in wrap(text):
            self.lines.append(('dimline', w))

    def render(self, cursor_after=None):
        img = base_canvas()
        d = ImageDraw.Draw(img)
        # eyebrow
        if self.eyebrow:
            spaced = ' '.join(self.eyebrow)
            centered(d, 168, spaced, mono_s, GOLD)
        # panel
        d.rounded_rectangle([48, 300, 1032, 1560], radius=26, fill=PANEL,
                            outline=PANEL_BD, width=2)
        for i, cx in enumerate([96, 128, 160]):
            d.ellipse([cx - 9, 336 - 9, cx + 9, 336 + 9], fill=GOLD_DIM)
        d.text((196, 336), 'spendguard · live demo', font=mono_s, fill=DIM, anchor='lm')
        d.line([84, 384, 996, 384], fill=PANEL_BD, width=2)
        # body (last N lines)
        y, lh, maxy = 414, 46, 1520
        hist = self.lines[-24:]
        for kind, payload in hist:
            if y + lh > maxy:
                break
            if kind == 'cmd':
                body = payload[2:] if payload.startswith('$ ') else payload
                _, y = draw_cmd(d, 84, y, body, lh, maxy, cursor=(cursor_after == payload))
            elif kind == 'comment':
                d.text((84, y), payload, font=mono, fill=DIM)
            elif kind == 'dimline':
                d.text((84, y), payload, font=mono, fill=DIM)
            else:
                draw_segs(d, 84, y, payload, mono)
            y += lh
        # caption
        if self.caption:
            d.line([300, 1652, 780, 1652], fill=GOLD, width=3)
            for j, cl in enumerate(wrap(self.caption, 46)):
                centered(d, 1704 + j * 48, cl, sans_s, TEXT)
        return img

# ---------- title / end cards ----------
def title_card(eyebrow, line1, line2=None, c1=TEXT, c2=GOLD):
    img = base_canvas()
    d = ImageDraw.Draw(img)
    if eyebrow:
        centered(d, 300, ' '.join(eyebrow), mono_s, GOLD_DIM)
    centered(d, 900, line1, sans, c1)
    if line2:
        centered(d, 992, line2, sans, c2)
    d.line([440, 1080, 640, 1080], fill=GOLD_DIM, width=2)
    return img

def end_card(stage):
    img = base_canvas()
    d = ImageDraw.Draw(img)
    items = []
    items.append(lambda: centered(d, 640, 'x402-spendguard', sans_b, GOLD))
    if stage >= 2:
        items.append(lambda: centered(d, 760, 'v0.2.0 — the control layer', sans_m, TEXT))
        items.append(lambda: centered(d, 820, 'for agent wallets.', sans_m, TEXT))
    if stage >= 3:
        d.line([440, 920, 640, 920], fill=GOLD_DIM, width=2)
        items.append(lambda: centered(d, 1010, 'Built by baby-zack-agent', sans_s, DIM))
    if stage >= 4:
        items.append(lambda: centered(d, 1090, 'github.com/baby-zack-agent/x402-spendguard', sans_s, GOLD))
    for fn in items:
        fn()
    return img

# ---------- timeline ----------
_scenes = []   # list of scenes; each scene = list of (image, duration)
segs = []      # segs of the scene currently being built
def hold(img, dur):
    segs.append((img, dur))

def new_scene():
    global segs
    if segs:
        _scenes.append(segs)
    segs = []

def type_cmd(screen, full_cmd, cps=3):
    body = full_cmd[2:] if full_cmd.startswith('$ ') else full_cmd
    for n in range(1, len(body) + 1, cps):
        hold(screen.render_partial(body[:n]), 1 / FPS)
    screen.add_cmd(full_cmd)
    hold(screen.render(cursor_after=full_cmd), 0.35)

def stream_lines(screen, lines, per=0.16, final_hold=0.8):
    for ln in lines:
        screen.add_line(ln)
        hold(screen.render(), per)
    hold(screen.render(), final_hold)

def main():
    shots = json.load(open(os.path.join(DEMO, 'shots.json')))
    s1, s2, s3 = shots['scene1'], shots['scene2'], shots['scene3']

    # hook
    hold(title_card('X402-SPENDGUARD · V0.2.0', 'Your agent just got an inbox.'), 4.4)
    new_scene()
    hold(title_card(None, "Who's watching its wallet?", c1=GOLD), 2.8)
    new_scene()

    # ---- scene 1 ----
    sc = Screen('01 — THE ATTACK', 'Runaway loop. Frozen in under a second.')
    hold(sc.render(), 0.6)
    type_cmd(sc, s1['cmd'])
    sc.add_comment(s1['comment']); hold(sc.render(), 0.7)
    allows = [l['text'] for l in s1['lines'] if l['status'] == 'ALLOW']
    denies = [l['text'] for l in s1['lines'] if l['status'] == 'DENIED']
    for ln in allows:
        sc.add_line(ln); hold(sc.render(), 0.15)
    hold(sc.render(), 0.4)
    sc.add_line(denies[0]); hold(sc.render(), 1.8)
    for ln in denies[1:]:
        sc.add_line(ln); hold(sc.render(), 0.5)
    hold(sc.render(), 1.2)
    type_cmd(sc, s1['checkCmd'])
    for w in wrap(s1['checkOut']):
        sc.add_line(w); hold(sc.render(), 0.10)
    hold(sc.render(), 2.6)
    new_scene()

    # ---- scene 2 ----
    sc2 = Screen('02 — THE BIG ONE', 'Big moves wait for a human.')
    hold(sc2.render(), 0.6)
    type_cmd(sc2, s2['cmd'])
    sc2.add_line(s2['heldLine']); hold(sc2.render(), 1.8)
    type_cmd(sc2, s2['queueCmd'])
    for w in wrap(s2['queueOut']):
        sc2.add_line(w); hold(sc2.render(), 0.12)
    hold(sc2.render(), 1.8)
    type_cmd(sc2, s2['approveCmd'])
    for w in wrap(s2['approveOut']):
        sc2.add_line(w); hold(sc2.render(), 0.12)
    hold(sc2.render(), 2.0)
    type_cmd(sc2, s2['auditCmd'])
    for w in wrap(s2['auditOut']):
        sc2.add_line(w); hold(sc2.render(), 0.12)
    hold(sc2.render(), 2.4)
    new_scene()

    # ---- scene 3 ----
    sc3 = Screen('03 — THE LONG GAME', 'Always-on agents need mission budgets, not just daily caps.')
    hold(sc3.render(), 0.6)
    type_cmd(sc3, s3['cmd'])
    sc3.add_dim(s3['envelope']); hold(sc3.render(), 1.0)
    for ln in [l['text'] for l in s3['lines'] if l['status'] == 'ALLOW']:
        sc3.add_line(ln); hold(sc3.render(), 0.38)
    hold(sc3.render(), 0.9)
    sc3.add_line([l['text'] for l in s3['lines'] if l['status'] == 'DENIED'][0])
    hold(sc3.render(), 2.0)
    type_cmd(sc3, s3['checkCmd'])
    for w in wrap(s3['checkOut']):
        sc3.add_line(w); hold(sc3.render(), 0.10)
    hold(sc3.render(), 2.4)
    new_scene()

    # ---- end card ----
    for stage, dur in [(1, 1.2), (2, 1.6), (3, 1.6), (4, 6.0)]:
        hold(end_card(stage), dur)
        new_scene()

    # ---- assemble scenes with crossfades at boundaries ----
    scenes = _scenes  # list of seg-lists, built via new_scene()
    frames = []  # (img, dur)
    FADE_N = 10
    for si, scene in enumerate(scenes):
        for img, dur in scene:
            frames.append((img, dur))
        if si < len(scenes) - 1 and scene and scenes[si + 1]:
            a, b = scene[-1][0], scenes[si + 1][0][0]
            for k in range(1, FADE_N + 1):
                frames.append((Image.blend(a, b, k / FADE_N), 1 / FPS))

    # ---- write frames with progress bar ----
    os.makedirs(FRAMES, exist_ok=True)
    total = sum(d for _, d in frames)
    t = 0.0
    lst = open('/tmp/sgdemo/list.txt', 'w')
    for i, (img, dur) in enumerate(frames):
        c = img.copy()
        d = ImageDraw.Draw(c)
        pw = int(W * min(1.0, (t + dur / 2) / total))
        d.rectangle([0, H - 8, pw, H], fill=GOLD)
        p = f'{FRAMES}/f{i:05d}.png'
        c.save(p)
        lst.write(f"file '{p}'\nduration {dur:.4f}\n")
        t += dur
        if i == len(frames) - 1:
            # concat demuxer drops the trailing duration; repeat the last
            # file so the final hold is honored
            lst.write(f"file '{p}'\n")
    lst.close()
    print(f'frames: {len(frames)}, total: {t:.1f}s')
    os.system(f'ffmpeg -y -loglevel error -f concat -safe 0 -i /tmp/sgdemo/list.txt '
              f'-r {FPS} -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart "{OUT}"')
    print('wrote', OUT)


# render_partial for typewriter (Screen method injected)
def _render_partial(self, partial):
    img = base_canvas()
    d = ImageDraw.Draw(img)
    if self.eyebrow:
        centered(d, 168, ' '.join(self.eyebrow), mono_s, GOLD)
    d.rounded_rectangle([48, 300, 1032, 1560], radius=26, fill=PANEL, outline=PANEL_BD, width=2)
    for cx in [96, 128, 160]:
        d.ellipse([cx - 9, 336 - 9, cx + 9, 336 + 9], fill=GOLD_DIM)
    d.text((196, 336), 'spendguard · live demo', font=mono_s, fill=DIM, anchor='lm')
    d.line([84, 384, 996, 384], fill=PANEL_BD, width=2)
    y, lh, maxy = 414, 46, 1520
    hist = [l for l in self.lines if l[0] != '_partial'][-24:]
    for kind, payload in hist:
        if y + lh > maxy:
            break
        if kind == 'cmd':
            draw_segs(d, 84, y, [('$ ', GOLD), (payload[2:], TEXT)], mono_b)
        elif kind == 'comment':
            d.text((84, y), payload, font=mono, fill=DIM)
        elif kind == 'dimline':
            d.text((84, y), payload, font=mono, fill=DIM)
        else:
            draw_segs(d, 84, y, payload, mono)
        y += lh
    if y + lh <= maxy:
        draw_cmd(d, 84, y, partial, lh, maxy, cursor=True)
    if self.caption:
        d.line([300, 1652, 780, 1652], fill=GOLD, width=3)
        for j, cl in enumerate(wrap(self.caption, 46)):
            centered(d, 1704 + j * 48, cl, sans_s, TEXT)
    return img

Screen.render_partial = _render_partial

if __name__ == '__main__':
    main()
