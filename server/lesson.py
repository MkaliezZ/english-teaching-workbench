"""Generate classroom materials from a teacher's uploaded source."""
import argparse
import hashlib
import json
from pathlib import Path

import pymupdf
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt

from local_lesson import MaterialProblem, pdf_source, read_local, write_package


def box(slide, words, x, y, w, h, *, size=24, bold=False, linked=None):
    if linked is not None:
        shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor.from_string('205E4E')
        shape.line.fill.background()
        shape.click_action.target_slide = linked
    else:
        shape = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    text = shape.text_frame
    text.word_wrap = True
    text.margin_left = Inches(.16 if linked is not None else 0)
    text.margin_right = Inches(.14 if linked is not None else 0)
    text.margin_top = Inches(.11 if linked is not None else 0)
    text.margin_bottom = 0
    run = text.paragraphs[0].add_run()
    run.text = words
    run.font.name = 'Microsoft YaHei'
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor.from_string('FFFFFF' if linked is not None else '172E28')
    return shape


def read_pdf(material, pages):
    try:
        with pymupdf.open(material) as document:
            if not document.is_pdf or document.needs_pass or not len(document):
                raise MaterialProblem('MATERIAL_INVALID')
            if pages == 'auto':
                first, last = 1, min(3, len(document))
            else:
                try:
                    first, last = map(int, pages.split('-'))
                except ValueError:
                    raise MaterialProblem('MATERIAL_RANGE') from None
            if not 1 <= first <= last <= len(document) or last - first >= 20:
                raise MaterialProblem('MATERIAL_RANGE')
            return pdf_source(document, first, last)
    except MaterialProblem:
        raise
    except Exception:
        raise MaterialProblem('MATERIAL_INVALID') from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('material', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('track', choices=['k12', 'toefl', 'ielts'])
    parser.add_argument('pages')
    parser.add_argument('--filename')
    parser.add_argument('--goal', default='')
    args = parser.parse_args()
    if args.material.suffix.lower() == '.pdf':
        source = read_pdf(args.material, args.pages)
    else:
        if args.pages != 'auto':
            raise MaterialProblem('MATERIAL_RANGE')
        source = read_local(args.material)
    material_name = args.filename or args.material.name
    title = f'{Path(material_name).stem[:56]} · 课堂活动'
    locator = f'{material_name} · {source.label}'
    args.output.mkdir(parents=True, exist_ok=True)
    objective, slides = write_package(args.track, title, args.goal, locator, source, args.output, box)
    with args.material.open('rb') as material:
        source_hash = hashlib.file_digest(material, 'sha256').hexdigest()
    print(json.dumps({
        'title': title, 'objective': objective, 'source': locator, 'pages': source.label,
        'sha256': source_hash, 'activities': 3, 'slides': slides,
    }, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except MaterialProblem as error:
        raise SystemExit(str(error)) from None
