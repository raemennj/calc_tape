#!/usr/bin/env python3
"""
PDF to structured JSON converter.
Extracts text with font/position metadata and classifies each block as:
  - page_number, chapter_title, section_title, sub_title, body, quote, list_item
"""

import json
import sys
import fitz  # PyMuPDF


# ── Heuristic thresholds (tuned after inspecting font sizes in the PDF) ──────

def classify_block(block, page_font_stats):
    """
    Given a text block dict and page-level font stats, return an element type.
    """
    text = block["text"].strip()
    size = block["max_size"]
    bold = block["bold"]
    italic = block["italic"]
    x0 = block["bbox"][0]
    page_w = block["page_width"]
    median_size = page_font_stats["median"]

    if not text:
        return "empty"

    # Page numbers: short, numeric, near top or bottom of page
    if text.isdigit() and len(text) <= 4:
        return "page_number"

    # Very large text → chapter title
    if size >= median_size * 1.8:
        return "chapter_title"

    # Large bold text → section title
    if size >= median_size * 1.3 and bold:
        return "section_title"

    # Moderately large or bold centred text → sub_title
    if size >= median_size * 1.1 or (bold and size >= median_size):
        return "sub_title"

    # Italic body → quote / attributed text
    if italic and not bold:
        return "quote"

    # Indented or starts with bullet/dash → list_item
    if text.startswith(("•", "-", "–", "*", "◦")):
        return "list_item"
    if x0 > page_w * 0.12:  # noticeably indented
        return "list_item"

    return "body"


def spans_to_block(spans, page_width, page_height, page_num):
    """Merge a list of spans into a single block dict."""
    if not spans:
        return None

    texts = []
    sizes = []
    bold_count = 0
    italic_count = 0
    fonts = set()
    colors = set()

    x0 = min(s["bbox"][0] for s in spans)
    y0 = min(s["bbox"][1] for s in spans)
    x1 = max(s["bbox"][2] for s in spans)
    y1 = max(s["bbox"][3] for s in spans)

    for s in spans:
        t = s["text"]
        texts.append(t)
        sizes.append(s["size"])
        fonts.add(s["font"])
        colors.add(s["color"])
        flags = s.get("flags", 0)
        if flags & 2**4:  # bold flag in PDF
            bold_count += 1
        if flags & 2**1:  # italic flag
            italic_count += 1

    full_text = "".join(texts).strip()
    max_size = max(sizes)
    avg_size = round(sum(sizes) / len(sizes), 2)

    return {
        "text": full_text,
        "page": page_num,
        "bbox": [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)],
        "page_width": page_width,
        "page_height": page_height,
        "max_size": round(max_size, 2),
        "avg_size": avg_size,
        "bold": bold_count > len(spans) / 2,
        "italic": italic_count > len(spans) / 2,
        "fonts": sorted(fonts),
        "colors": [f"#{c:06x}" if isinstance(c, int) else str(c) for c in colors],
    }


def page_font_stats(blocks):
    """Compute median font size across all blocks on a page."""
    sizes = [b["max_size"] for b in blocks if b["text"]]
    if not sizes:
        return {"median": 12}
    sizes.sort()
    mid = len(sizes) // 2
    return {"median": sizes[mid]}


def pdf_to_json(pdf_path):
    doc = fitz.open(pdf_path)
    output = {
        "source": pdf_path,
        "total_pages": doc.page_count,
        "pages": []
    }

    for page_index in range(doc.page_count):
        page = doc[page_index]
        page_num = page_index + 1
        width = round(page.rect.width, 2)
        height = round(page.rect.height, 2)

        # Extract word-level blocks with span metadata
        raw_blocks = page.get_text("rawdict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]

        page_blocks = []
        for b in raw_blocks:
            if b["type"] != 0:  # skip images
                continue
            for line in b["lines"]:
                spans = line["spans"]
                block = spans_to_block(spans, width, height, page_num)
                if block and block["text"]:
                    page_blocks.append(block)

        # Compute font stats for classification
        stats = page_font_stats(page_blocks)

        # Classify and build final elements
        elements = []
        for block in page_blocks:
            etype = classify_block(block, stats)
            block["type"] = etype
            # Remove internal helpers not needed in output
            block.pop("page_width", None)
            block.pop("page_height", None)
            elements.append(block)

        output["pages"].append({
            "page": page_num,
            "width": width,
            "height": height,
            "elements": elements
        })

    return output


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 pdf_to_json.py <input.pdf> [output.json]")
        sys.exit(1)

    pdf_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else pdf_path.replace(".pdf", ".json")

    print(f"Parsing {pdf_path} ...")
    data = pdf_to_json(pdf_path)
    print(f"  {data['total_pages']} pages, writing to {out_path}")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print("Done.")


if __name__ == "__main__":
    main()
