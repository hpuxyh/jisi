"""生成集思扩展图标 - 暖橙圆角方形 + 白色 sparkle"""
from PIL import Image, ImageDraw
import math


def make_gradient(size, start, end):
    """从左上到右下的对角渐变"""
    img = Image.new('RGBA', (size, size))
    px = img.load()
    diag = (size - 1) * math.sqrt(2)
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            r = int(start[0] + (end[0] - start[0]) * t)
            g = int(start[1] + (end[1] - start[1]) * t)
            b = int(start[2] + (end[2] - start[2]) * t)
            px[x, y] = (r, g, b, 255)
    return img


def rounded_rect_mask(size, radius):
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_sparkle(img, cx, cy, size, color=(255, 255, 255, 255)):
    """画一个四角星（与 Lucide Sparkles 神似的简化几何）"""
    d = ImageDraw.Draw(img)
    half = size / 2
    arm = size * 0.45
    waist = size * 0.13

    # 主四角星：纵横两条十字菱形
    main = [
        (cx, cy - arm),
        (cx + waist, cy - waist),
        (cx + arm, cy),
        (cx + waist, cy + waist),
        (cx, cy + arm),
        (cx - waist, cy + waist),
        (cx - arm, cy),
        (cx - waist, cy - waist),
    ]
    d.polygon(main, fill=color)

    # 右上角小星点
    s2 = size * 0.22
    a2 = s2 * 0.5
    w2 = s2 * 0.15
    ox, oy = cx + arm * 0.85, cy - arm * 0.85
    star2 = [
        (ox, oy - a2),
        (ox + w2, oy - w2),
        (ox + a2, oy),
        (ox + w2, oy + w2),
        (ox, oy + a2),
        (ox - w2, oy + w2),
        (ox - a2, oy),
        (ox - w2, oy - w2),
    ]
    d.polygon(star2, fill=color)


def make_icon(size):
    # 暖橙渐变（对应应用里的 #d4a574 → #b8845a）
    bg = make_gradient(size, (212, 165, 116), (184, 132, 90))

    # 圆角裁剪
    radius = int(size * 0.22)
    mask = rounded_rect_mask(size, radius)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)

    # 白色 sparkle 居中
    draw_sparkle(out, size / 2, size / 2, size * 0.55)
    return out


if __name__ == '__main__':
    import sys
    out_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
    for s in [16, 32, 48, 128]:
        icon = make_icon(s)
        path = f'{out_dir}/icon-{s}.png'
        icon.save(path)
        print(f'  {path}')
    print('done')
