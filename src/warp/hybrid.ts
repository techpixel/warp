import { Vector2D } from "../vector.lib";
import { interp as mvc } from "./mvc";
import { interp as green } from "./green";

const blend = 0.5;

export function interp(point: Vector2D, icage: Vector2D[], dcage: Vector2D[], log: (log: any) => void = (a) => {}) {
    return mvc(point, icage, dcage, log).scale(blend).add(green(point, icage, dcage, log).scale(1 - blend));
}