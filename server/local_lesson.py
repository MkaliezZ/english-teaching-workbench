"""Extract local materials into a teacher-reviewed, source-led classroom package."""
from base64 import b64encode
from dataclasses import dataclass
from html import escape
from io import BytesIO
from pathlib import Path
import re
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring
from PIL import Image, ImageOps
import pymupdf
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches

from slide_effects import fade_on_click, transition


class MaterialProblem(Exception):
    pass


@dataclass
class Source:
    label: str
    excerpts: list[str]
    image: bytes | None = None


WORD_NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
TEXT_CAP = 14000
IMAGE_CAP = 18000000
PATTERNS = {
    'k12': ('用英语复述材料里的一个细节，并给出一个新例子。', '说一句完整的英文句子。替换一个人物、地点或动作，再说一次。'),
    'toefl': ('用英文说明材料的主要信息，并指出能支持判断的一处证据。', '先让同伴给出主要信息或下一步行动，再要求他指出证据。换一个细节，重新判断。'),
    'ielts': ('区分材料里的观察与推测，写一句归纳和一句有依据的细节。', '和同伴交换归纳句。检查它有没有加入材料未提供的解释，再换一种比较方式。'),
}


def excerpts(text):
    blocks = re.split(r'\n\s*\n|(?<=[。！？])(?=\S)|(?<=[.!?])\s+(?=[A-Z])', text[:TEXT_CAP])
    result = []
    for block in blocks:
        line = ' '.join(block.split()).strip()
        if line and any(char.isalnum() for char in line):
            result.extend(line[index:index + 280] for index in range(0, len(line), 280))
        if len(result) >= 4:
            break
    return result[:4]


def picture_from_pillow(image):
    if image.width * image.height > IMAGE_CAP or image.width < 1 or image.height < 1:
        raise MaterialProblem('MATERIAL_INVALID')
    image = ImageOps.exif_transpose(image)
    image.thumbnail((1440, 1440))
    result = BytesIO()
    image.convert('RGB').save(result, format='JPEG', quality=88)
    return result.getvalue()


def pdf_source(document, first, last):
    result = []
    for i in range(first - 1, last):
        for text in excerpts(document[i].get_text()):
            result.append(f'PDF 第 {i + 1} 页 · {text}')
            if len(result) == 4:
                break
        if len(result) == 4:
            break
    label = f'PDF 第 {first}–{last} 页' if first != last else f'PDF 第 {first} 页'
    if result:
        return Source(label, result)
    page = document[first - 1]
    scale = min(2, 1350 / max(page.rect.width, page.rect.height))
    image = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes('jpeg', jpg_quality=88)
    return Source(f'PDF 第 {first} 页 · 页面图像', [], image)


def office_source(path):
    with ZipFile(path) as package:
        entries = package.infolist()
        if len(entries) > 2000 or sum(item.file_size for item in entries) > 120 * 1024 * 1024:
            raise MaterialProblem('MATERIAL_INVALID')
        if path.suffix == '.docx':
            if package.getinfo('word/document.xml').file_size > 8 * 1024 * 1024:
                raise MaterialProblem('MATERIAL_INVALID')
            doc = fromstring(package.read('word/document.xml'))
            paras = (''.join(element.text or '' for element in para.iter(f'{WORD_NS}t')) for para in doc.iter(f'{WORD_NS}p'))
            return Source('Word 文档 · 正文与表格文字', excerpts('\n\n'.join(paras)))
        if 'ppt/presentation.xml' not in package.namelist():
            raise MaterialProblem('MATERIAL_INVALID')
    result = []
    for i, slide in enumerate(Presentation(path).slides, 1):
        for shape in slide.shapes:
            if shape.has_text_frame:
                text = shape.text
            elif shape.has_table:
                text = '\n'.join(cell.text for row in shape.table.rows for cell in row.cells)
            else:
                continue
            result.extend(f'幻灯片第 {i} 页 · {line}' for line in excerpts(text))
            if len(result) >= 4:
                return Source('PPTX · 幻灯片文字', result[:4])
    return Source('PPTX · 幻灯片文字', result)


def read_local(path):
    try:
        if path.suffix in ('.docx', '.pptx'):
            source = office_source(path)
        elif path.suffix in ('.txt', '.md'):
            data = path.read_bytes()
            if b'\x00' in data:
                raise MaterialProblem('MATERIAL_INVALID')
            try:
                text = data.decode('utf-8-sig')
            except UnicodeDecodeError:
                text = data.decode('gb18030')
            if any(not letter.isprintable() and letter not in '\n\r\t' for letter in text):
                raise MaterialProblem('MATERIAL_INVALID')
            source = Source('Markdown · 原文' if path.suffix == '.md' else 'TXT · 原文', excerpts(text))
        elif path.suffix in ('.png', '.jpg', '.jpeg', '.webp'):
            with Image.open(path) as image:
                expected = {'.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP'}[path.suffix]
                if image.format != expected:
                    raise MaterialProblem('MATERIAL_INVALID')
                source = Source(f'{expected} · 原图观察', [], picture_from_pillow(image))
        else:
            raise MaterialProblem('MATERIAL_INVALID')
    except MaterialProblem:
        raise
    except Exception:
        raise MaterialProblem('MATERIAL_INVALID') from None
    if not source.excerpts and not source.image:
        raise MaterialProblem('MATERIAL_EMPTY')
    return source


def local_html(title, goal, placement, source, transfer):
    if source.image:
        encoded = b64encode(source.image).decode('ascii')
        material = f'<details open><summary>查看 / 收起材料图像</summary><img src="data:image/jpeg;base64,{encoded}" alt="上传的课堂材料图像"></details><p>指出画面中能看到的一个细节。先描述，再讨论它说明了什么。</p>'
    else:
        buttons = ''.join(f'<button type="button" aria-pressed="false" data-evidence="{i}">片段 {i}</button>' for i in range(1, len(source.excerpts) + 1))
        quotes = ''.join(f'<blockquote id="excerpt-{i}" hidden>{escape(text)}</blockquote>' for i, text in enumerate(source.excerpts, 1))
        material = f'<p>点击一个原文片段，并说出其中一个支持你判断的细节。</p><div class="controls">{buttons}</div>{quotes}'
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>{escape(title)}</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f2eee4;color:#241d2e;font:16px/1.65 system-ui,sans-serif}}main{{max-width:960px;margin:auto;padding:clamp(15px,4vw,45px)}}header,section{{background:#fffdf8;border:1px solid #d6cfd6;border-radius:16px;margin-bottom:16px;padding:18px 24px}}header{{background:#302749;color:#fff}}h1{{line-height:1.12;margin:0;overflow-wrap:anywhere}}h2{{margin-top:0}}footer,p,blockquote{{overflow-wrap:anywhere}}footer{{font-size:.84rem;color:#5a4c62}}.controls{{display:flex;flex-wrap:wrap;gap:7px}}button,textarea{{font:inherit}}button{{padding:6px 12px;border-radius:8px;border:1px solid #8872a9;background:#fff;color:#302749;cursor:pointer}}button[aria-pressed=true],button[type=submit]{{background:#493469;color:white}}[hidden]{{display:none}}blockquote{{background:#eee8f7;border-left:4px solid #8165a6;margin:14px 0;padding:12px}}textarea{{display:block;width:100%;min-height:95px;margin:7px 0;padding:8px}}img{{max-width:100%;max-height:520px;display:block;margin:10px auto}}summary{{cursor:pointer;color:#4e396e;font-weight:700}}output{{display:block;min-height:1.3em}}button:focus-visible, summary:focus-visible,textarea:focus-visible{{outline:3px solid #a04f35;outline-offset:2px}}
</style></head><body><main><header><h1>{escape(title)}</h1><p>{escape(goal)}</p></header>
<section><h2>从材料里找细节</h2>{material}</section>
<section><h2>先写判断，再给依据</h2><form><label for="answer">写一句英文判断及一条支持它的原文或画面细节</label><textarea id="answer" maxlength="800" placeholder="I noticed ... My evidence is ..."></textarea><button type="submit">检查是否已填写</button><output role="status"></output></form><details><summary>同伴核对</summary><p>请另一位同学回到相同的文字或图像，指出依据在哪里，并检查它能否支持判断。</p></details></section>
<section><h2>换一个情境再试</h2><p>{escape(transfer)}</p><details><summary>教师追问</summary><p>只改原材料中的一个细节。请同伴说明哪部分判断需要随之改变，以及为什么。</p></details></section>
<footer>{escape(placement)} · 本地材料预览，请教师核对内容和使用范围。</footer></main><script>
const buttons = [...document.querySelectorAll('[data-evidence]')];
buttons.forEach(button => button.addEventListener('click', () => {{
  buttons.forEach(other => {{other.setAttribute('aria-pressed', String(other === button)); document.getElementById('excerpt-' + other.dataset.evidence).hidden = other !== button;}});
}}));
const form = document.querySelector('form');
form.addEventListener('submit', event => {{ event.preventDefault();
  form.querySelector('output').textContent = form.querySelector('textarea').value.trim() ? '已填写。请同伴回到材料核对你的依据。' : '先写一句判断，再补一条材料证据。';
}});
</script></body></html>'''


def write_package(track, title, goal, placement, source, folder, box):
    objective, transfer = PATTERNS[track]
    objective = goal or objective
    (folder / 'lesson.html').write_text(local_html(title, objective, placement, source, transfer), encoding='utf-8')
    deck = Presentation()
    deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
    deck.core_properties.title = title
    slides = [deck.slides.add_slide(deck.slide_layouts[6]) for _ in range(5)]
    for i, (slide, heading) in enumerate(zip(slides, ['课堂准备', '看一处材料', '做出判断', '说明依据', '换情境迁移']), 1):
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = RGBColor.from_string('F5F0E9')
        box(slide, heading, .62, .64, 12, .67, size=36, bold=True)
        box(slide, f'{placement[:130]}  /  {i:02}', .62, 7.07, 12, .24, size=11)
        transition(slide, 'fade' if i % 2 else 'push', None if i % 2 else 'l')
    cover, read, task, explain, apply = slides
    box(cover, title[:80], .64, 1.72, 11.8, 1.14, size=35, bold=True)
    box(cover, objective, .64, 3.15, 11.8, 1.7, size=25)
    if source.image:
        with Image.open(BytesIO(source.image)) as image:
            ratio = image.width / image.height
        width = min(11.6, 4.48 * ratio)
        read.shapes.add_picture(BytesIO(source.image), Inches(.65), Inches(1.49), width=Inches(width))
    else:
        evidence = max(source.excerpts, key=lambda quote: sum(char.isalnum() for char in quote))
        box(read, evidence, .65, 1.57, 11.5, 3.6, size=23)
    box(task, '用一句英文说明你的观察。\n\n写下一条能支持它的材料证据，再交给同伴核对。', .65, 1.62, 11.5, 3.9, size=27)
    callout = box(explain, '你的判断    →    材料中的文字或画面细节    →    为什么它支持你的判断', .65, 1.70, 11.4, 1.65, size=25, bold=True)
    fade_on_click(explain, callout)
    box(explain, '放映时单击空白处，揭晓核对顺序。', .65, 4.5, 11.4, .45, size=16)
    box(apply, transfer, .65, 1.60, 11.5, 3.6, size=26)
    for slide, target in zip(slides, [read, task, explain, apply, cover]):
        box(slide, '继续 →' if slide != apply else '返回首页', .65, 6.03, 2.7, .58, size=18, linked=target)
    deck.save(folder / 'lesson.pptx')
    return objective, 5
