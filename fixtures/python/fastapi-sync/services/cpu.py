"""Example 5: a CPU route, with 1,000+ calls of short functions per request."""


def score(count):
    return sum(weight(index) for index in range(count))


def weight(index):
    return square(index % 7) + 1


def square(value):
    return value * value
