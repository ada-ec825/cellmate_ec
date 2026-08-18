# Dispatch manifest

Implement only the eight named functions in the provided scaffold. Do not rename them. Do not add top-level test or print statements.

## `dispatch_manifest(order_id, lines, hazard_code)`

Return a dictionary with exactly the keys `"order_id"`, `"units"`, `"handling"`, and `"charge"`. Their values must respectively be the supplied order id, total units for `lines`, handling code for `lines` and `hazard_code`, and dispatch charge for those inputs. Obtain the computed values through the named helper functions.

## `dispatch_charge(lines, hazard_code)`

Compute the total units, handling code, base charge, and surcharge through the helper functions below. Return base charge plus surcharge, rounded to two decimal places.

## `surcharge(base, handling)`

Return 50% of `base` for `"special"` and 25% for `"caution"`, rounded to two decimal places. Return zero for `"standard"` or any other handling value.

## `base_charge(units)`

`units` is a non-negative integer. Return `0` for zero units, `8` for 1–50 units, `15` for 51–100 units, and `25` above 100 units.

## `handling_code(lines, hazard_code)`

Return `"special"` when `hazard_level(hazard_code)` is `"high"` or `total_units(lines)` is above 100. Otherwise return `"caution"` for a medium hazard and `"standard"` for a low hazard.

## `hazard_level(hazard_code)`

`hazard_code` is a string. Codes are case-insensitive: `"H"` and `"X"` are high, `"M"` is medium, and every other code is low.

## `total_units(lines)`

`lines` is a list of `(pack_size, pack_count)` pairs of non-negative integers. Return the sum of `line_units(pack_size, pack_count)` for all lines. An empty list returns `0`.

## `line_units(pack_size, pack_count)`

Return the product of the two non-negative integer arguments.
