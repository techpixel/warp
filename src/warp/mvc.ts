import { Vector2D } from "../vector.lib";

export function interp(point: Vector2D, icage: Vector2D[], dcage: Vector2D[], log: (log: any) => void = (a) => {}) {
    var s: Vector2D[] = [];
    var r: number[] = [];
    var A: number[] = [];
    var D: number[] = [];

    for (var i = 0; i < icage.length; i++) {
        s[i] = icage[i].sub(point);
        log(s[i]);
    }

    for (var i = 0; i < icage.length; i++) {
        var ni = (i + 1) % icage.length;
        r[i] = s[i].norm();
        A[i] = s[i].det(s[ni])/2;
        D[i] = s[i].dot(s[ni]);
        if (r[i] == 0) return dcage[i];
        if (A[i] == 0 && D[i] < 0) {
            r[ni] = s[ni].norm();

            var itm = dcage[i].scale(r[ni]).add(dcage[ni].scale(r[i])); 

            return itm.scale(1/(r[i]+r[ni]));
        }
    }

    var f = new Vector2D();
    var W = 0;

    for (var i = 0; i < icage.length; i++) {
        var ni = (i + 1) % icage.length;
        var bi = ((i - 1 + icage.length) % icage.length);
        var w = 0;
        if (A[bi] != 0) {
            w = w + (r[bi] - (D[bi]/r[i]))/A[bi];
        }
        if (A[i] != 0) {
            w = w + (r[ni] - (D[i]/r[i]))/A[i];
        }
        f = f.add(dcage[i].scale(w));
        W = W + w;
    }

    // console.log(W);

    return f.scale(1/W);
}
