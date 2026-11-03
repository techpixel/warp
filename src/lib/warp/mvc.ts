export function weights(x: number, y: number, rest: Float64Array, log: (log: any) => void = (a) => {}) {
    var n = rest.length / 2;
    var sx = new Float64Array(n);
    var sy = new Float64Array(n);
    var r = new Float64Array(n);
    var A = new Float64Array(n);
    var D = new Float64Array(n);
    var w = new Float64Array(n);

    for (var i = 0; i < n; i++) {
        sx[i] = rest[2 * i] - x;
        sy[i] = rest[2 * i + 1] - y;
        log([sx[i], sy[i]]);
    }

    for (var i = 0; i < n; i++) {
        var ni = (i + 1) % n;
        r[i] = Math.sqrt(sx[i] * sx[i] + sy[i] * sy[i]);
        A[i] = (sx[i] * sy[ni] - sy[i] * sx[ni]) / 2;
        D[i] = sx[i] * sx[ni] + sy[i] * sy[ni];
        if (r[i] == 0) {
            w[i] = 1;
            return w;
        }
        if (A[i] == 0 && D[i] < 0) {
            r[ni] = Math.sqrt(sx[ni] * sx[ni] + sy[ni] * sy[ni]);
            w[i] = r[ni] / (r[i] + r[ni]);
            w[ni] = r[i] / (r[i] + r[ni]);
            return w;
        }
    }

    var W = 0;

    for (var i = 0; i < n; i++) {
        var ni = (i + 1) % n;
        var bi = (i - 1 + n) % n;
        var wi = 0;
        if (A[bi] != 0) {
            wi = wi + (r[bi] - (D[bi] / r[i])) / A[bi];
        }
        if (A[i] != 0) {
            wi = wi + (r[ni] - (D[i] / r[i])) / A[i];
        }
        w[i] = wi;
        W = W + wi;
    }

    for (var i = 0; i < n; i++) {
        w[i] = w[i] / W;
    }

    return w;
}

export function deformer(rest: Float64Array, moved: Float64Array, log: (log: any) => void = (a) => {}) {
    var n = moved.length / 2;

    return (w: Float64Array, out: Float64Array) => {
        var x = 0;
        var y = 0;
        for (var i = 0; i < n; i++) {
            x += w[i] * moved[2 * i];
            y += w[i] * moved[2 * i + 1];
        }
        out[0] = x;
        out[1] = y;
    };
}
