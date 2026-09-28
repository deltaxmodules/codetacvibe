import time


def build_report(size):
    rows = [make_row(index) for index in range(size)]
    time.sleep(0.02)
    return {'rows': len(rows), 'total': total(rows)}


def make_row(index):
    return {'index': index, 'value': index * 3}


def total(rows):
    return sum(row['value'] for row in rows)
