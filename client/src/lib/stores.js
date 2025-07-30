import { writable } from 'svelte/store';

export const error = writable(null);
export const isRouting = writable(false);
export const routeCoords = writable([]);
export const routeSteps = writable([]);
export const chapelArrived = writable(false);
