## Ranking exam marks

A tutor keeps the marks of a small class in a list, in the order the scripts
happened to be picked up. Write a function `order_scores(scores)` that takes
such a list of numbers and returns a new list holding the same marks arranged
from lowest to highest.

Build the ordered list yourself, one mark at a time: take each mark in turn and
place it where it belongs among the marks you have already arranged. You may
not use the built-in `sorted()` function or the `list.sort()` method.

The tutor still needs the original list untouched afterwards, and the function
must cope with an empty list and with several scripts sharing the same mark.
