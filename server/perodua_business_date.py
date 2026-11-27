"""Perodua operational date from the PDF's Malaysia-local delivery timestamp."""
from datetime import datetime, timedelta


def delivery_business_date(data):
    try:
        delivery = datetime.strptime(f"{data['delivery_date']} {data['delivery_time']}", '%Y-%m-%d %H:%M')
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError('A valid PDF delivery date/time is required for the 08:00 cutoff.') from error
    return (delivery - timedelta(hours=8)).date().isoformat()
