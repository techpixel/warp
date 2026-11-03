import { weights as mvcWeights, deformer as mvcDeformer } from "./mvc";
import { weights as greenWeights, deformer as greenDeformer } from "./green";

// A blend of MVC and Green: `blend` is MVC's share of the result (the rest is
// Green's). The two are blended after each is applied, so changing the blend
// doesn't need new weights.

export const DEFAULT_BLEND = 0.5;

/** MVC's weights, then Green's, in one array. */
export function weights(x: number, y: number, rest: Float64Array, log: (log: any) => void = (a) => {}) {
    var m = mvcWeights(x, y, rest, log);
    var g = greenWeights(x, y, rest, log);
    var w = new Float64Array(m.length + g.length);
    w.set(m);
    w.set(g, m.length);
    return w;
}

export function deformer(rest: Float64Array, moved: Float64Array, log: (log: any) => void = (a) => {}, { blend = DEFAULT_BLEND } = {}) {
    var n = rest.length / 2;
    var mvc = mvcDeformer(rest, moved, log);
    var green = greenDeformer(rest, moved, log);
    var pm = new Float64Array(2);
    var pg = new Float64Array(2);
    return (w: Float64Array, out: Float64Array) => {
        mvc(w.subarray(0, n), pm);
        green(w.subarray(n), pg);
        out[0] = blend * pm[0] + (1 - blend) * pg[0];
        out[1] = blend * pm[1] + (1 - blend) * pg[1];
    };
}
