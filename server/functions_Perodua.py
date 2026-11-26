import json

import math

from datetime import datetime

from pathlib import Path

import re



import pymupdf



def collect_client(text):

    included_words = ("PERODUA","TOYOTA")





def collect_PIDO(text):

    """Read one document ID; the supplied PDF spells the label PDIO Number."""

    pattern = (

        r"^[ \t]*(?:PIDO|PDIO)(?:[ \t]+Number)?[ \t]*:?[ \t]*"

        r"(?:\r?\n[ \t]*)?([A-Z0-9][A-Z0-9/-]*)[ \t]*$"

    )

    values = {

        match.group(1)

        for match in re.finditer(pattern, text, re.IGNORECASE | re.MULTILINE)

        if match.group(1).casefold() != "number"

    }

    if not values:

        raise ValueError("PIDO / PDIO Number was not found in this document.")

    if len(values) != 1:

        raise ValueError("Multiple different PIDO / PDIO numbers were found.")

    # Keep this as text: PG6952818 contains letters, and IDs can have leading zeros.

    return next(iter(values))





def collect_delivery_datetime(text):

    """Read the scheduled delivery date/time printed in the PDF."""

    pattern = (

        r"\bDelivery\s+Date\s*/\s*Time\s*:?\s*"

        r"([0-9]{1,2}/[0-9]{1,2}/(?:[0-9]{4}|[0-9]{2}))\b"

        r"\s+([0-9]{1,2}:[0-9]{2})(?:\s*(AM|PM)\b)?"

    )

    values = set()

    for match in re.finditer(pattern, text, re.IGNORECASE):

        date, time, meridian = match.groups()

        value = f"{date} {time}"

        time_format = "%H:%M"

        if meridian:

            value += f" {meridian.upper()}"

            time_format = "%I:%M %p"

        for date_format in ("%d/%m/%Y", "%d/%m/%y"):

            try:

                delivery = datetime.strptime(value, f"{date_format} {time_format}")

                break

            except ValueError:

                continue

        else:

            raise ValueError(f"Invalid delivery date/time: {value!r}")

        values.add((delivery.strftime("%Y-%m-%d"), delivery.strftime("%H:%M")))



    if not values:

        raise ValueError("Delivery Date/Time was not found in this document.")

    if len(values) != 1:

        raise ValueError("Multiple different delivery dates/times were found.")

    date, time = next(iter(values))

    return {"delivery_date": date, "delivery_time": time}





def read_integer(value, field, number):

    if not re.fullmatch(r"[0-9]+(?:,[0-9]{3})*", value):

        raise ValueError(f"Item {number}: invalid {field}: {value!r}")

    return int(value.replace(",", ""))





def is_item_start(lines, index):

    """A row starts with a number, a Back No (e.g. GC 501), then a part number."""

    return (

        index + 2 < len(lines)

        and re.fullmatch(r"[0-9]+", lines[index]) is not None

        and re.fullmatch(r"[A-Z][A-Z0-9_-]*(?:[ \t]+[A-Z0-9_-]+)*", lines[index + 1]) is not None

        and re.fullmatch(r"[A-Z0-9]+(?:-[A-Z0-9]+)+", lines[index + 2]) is not None

    )





def collect_column(text):

    """Collect all numbered items after the P2 heading on one PDF page."""

    # Preserve whole lines, so a multiword part name remains one value.

    lines = [line.strip() for line in text.splitlines() if line.strip()]

    try:

        start = next(i for i, line in enumerate(lines) if line.casefold() == "p2") + 1

    except StopIteration:

        return []



    end = next(

        (i for i in range(start, len(lines))

         if lines[i].casefold() in {"total by page", "grand total"}),

        len(lines),

    )

    body = lines[start:end]

    if not body:

        return []



    starts = [i for i in range(len(body)) if is_item_start(body, i)]

    if not starts or starts[0] != 0:

        raise ValueError("The text after P2 does not start with a recognised item row.")



    items = []

    for position, begin in enumerate(starts):

        finish = starts[position + 1] if position + 1 < len(starts) else len(body)

        row = body[begin:finish]

        number = int(row[0])

        if len(row) < 9:

            raise ValueError(f"Item {number}: some item fields are missing.")



        # The final five fields have fixed positions. A part name may wrap

        # over several lines, so combine everything between part_no and color.

        item = {

            "number": number,

            "back_no": row[1],

            "part_no": row[2],

            "part_name": " ".join(row[3:-5]),

            "color": row[-5],

            "qty_per_box": read_integer(row[-4], "qty_per_box", number),

            "total_box": read_integer(row[-3], "total_box", number),

            "total_qty": read_integer(row[-2], "total_qty", number),

        }

        try:

            volume = float(row[-1].replace(",", ""))

        except ValueError as error:

            raise ValueError(f"Item {number}: invalid total_m3: {row[-1]!r}") from error

        if not math.isfinite(volume) or volume < 0:

            raise ValueError(f"Item {number}: invalid total_m3: {row[-1]!r}")

        item["total_m3"] = volume



        if item["qty_per_box"] * item["total_box"] != item["total_qty"]:

            raise ValueError(f"Item {number}: qty_per_box x total_box does not equal total_qty.")

        items.append(item)



    return items





def collect_delivery_trip(text):

    """Read the actual Delivery Trip label; never infer it from row numbers."""

    values = {int(match.group(1)) for match in re.finditer(

        r"\bDelivery\s+Trip\s*:?\s*([0-9]+)\b", text, re.IGNORECASE

    )}

    if not values:

        return None

    if len(values) != 1 or next(iter(values)) < 1:

        raise ValueError("Delivery Trip is invalid or conflicting in this document.")

    return next(iter(values))





def parse_document(page_texts):

    document_text = "\n".join(page_texts)

    pido = collect_PIDO(document_text)

    delivery = collect_delivery_datetime(document_text)

    items = []

    for page_number, text in enumerate(page_texts, start=1):

        try:

            items.extend(collect_column(text))

        except ValueError as error:

            raise ValueError(f"Page {page_number}: {error}") from error

    if not items:

        raise ValueError("No item rows were found after a P2 heading.")

    return {"PIDO": pido, **delivery, "delivery_trip": collect_delivery_trip(document_text), "Item": items}





def extract_page_texts(pdf_bytes):

    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:

        if doc.needs_pass:

            raise ValueError("Please upload an unlocked PDF.")

        page_texts = [page.get_text() for page in doc]

    return page_texts
