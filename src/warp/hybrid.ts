import { weights as mvc } from "./mvc";
import { weights as green } from "./green";

export { deformer } from "./green";

const blend = 0.5;

export function weights(x: number, y: number, rest: Float64Array, log: (log: any) => void = (a) => {}) {
    var m = mvc(x, y, rest, log);
    var w = green(x, y, rest, log);
    for (var i = 0; i < m.length; i++) {
        w[i] = blend * m[i] + (1 - blend) * w[i];
    }
    for (var i = m.length; i < w.length; i++) {
        w[i] = (1 - blend) * w[i];
    }
    return w;
}
