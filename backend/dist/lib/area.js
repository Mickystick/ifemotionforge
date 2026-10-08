/**
 * The units a project's areas may be entered and displayed in.
 *
 * Areas are always STORED in square metres (`lots.area_m2`). This list only
 * decides how a number is typed in and read back, so the server's job is
 * narrow: refuse a unit it does not know. The conversion factors live in the
 * frontend's copy of this file, where the converting actually happens.
 *
 * "vara" and "manzana" are the traditional Honduran land units and are in
 * everyday use in deeds and sales here, so they are not optional extras.
 */
export const AREA_UNITS = ["m2", "vara2", "manzana", "hectarea", "km2"];
export function isAreaUnit(value) {
    return AREA_UNITS.includes(value);
}
//# sourceMappingURL=area.js.map