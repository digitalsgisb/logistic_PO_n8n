"""One set of PG/PM/PK model conditions, shared with the history display."""
import json
from pathlib import Path
import re

MODEL_RULES = json.loads(Path(__file__).with_name('perodua-models.json').read_text(encoding='utf-8'))


def pido_family(pido):
    value = str(pido or '').strip().upper()
    if value.isascii() and value.isdigit():
        return 'PK'
    return next((prefix for prefix in ('PG', 'PM') if value.startswith(prefix)), 'OTHER')


def saved_family(families):
    families = set(families)
    if families == {'PM', 'PK'}:
        return 'PM_PK'
    return next(iter(families)) if len(families) == 1 else 'MIXED'


def normalize_back_no(value):
    return re.sub(r'\s+', '', str(value or '')).upper()


def middle_part_no(value):
    pieces = str(value or '').strip().upper().split('-')
    return pieces[1] if len(pieces) == 3 and all(pieces) else ''


def model_no(back_no, part_no=None, pido=None):
    # ===== EDIT PG / PM / PK CONDITIONS IN perodua-models.json =====
    key = normalize_back_no(back_no) + '|' + middle_part_no(part_no)
    return MODEL_RULES.get(pido_family(pido), {}).get(key, 'no model')


def pido_key(value):
    """Natural numeric order, including IDs with different numbers of digits."""
    return tuple((1, int(piece)) if piece.isdigit() else (0, piece.casefold())
                 for piece in re.split(r'(\d+)', str(value or '').strip()))


def item_number(item):
    value = item.get('number')
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else float('inf')


def pm_group(data, item):
    """PM groups use Back No, ignoring whitespace and case."""
    return (normalize_back_no(item.get('back_no')),)
