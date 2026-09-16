/**
 * The `zipcodes` npm package (davglass/zipcodes, BSD licensed, confirmed via
 * `npm view zipcodes` -- no dependencies, bundled US+Canada ZIP/postal code
 * data with lat/lng) ships no TypeScript declarations of its own and none
 * exist in @types. Only the two functions this codebase actually uses
 * (`lookup`, `distance`) are declared here, not the full surface (`random`,
 * `lookupByName`, `lookupByState`, `radius`, `lookupByCoords`,
 * `toMiles`/`toKilometers`) -- confirmed against the installed package's own
 * `lib/index.js`, not assumed from its README alone.
 */
declare module "zipcodes" {
  export interface ZipInfo {
    zip: string;
    latitude: number;
    longitude: number;
    city: string;
    state: string;
    country: string;
  }

  /** Looks up a single US/Canada ZIP/postal code. Returns undefined for an
   *  unrecognized code -- confirmed via source: a plain object-key miss,
   *  never a thrown error. */
  export function lookup(zip: string): ZipInfo | undefined;

  /** Great-circle ("as the crow flies," per the package's own README, not
   *  driving/shipping distance) distance in miles between two ZIP/postal
   *  codes. Returns null -- confirmed via source, not undefined or NaN -- if
   *  either code doesn't resolve via {@link lookup}. */
  export function distance(zipA: string, zipB: string): number | null;
}
