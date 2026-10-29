export function weights(x: number, y: number, rest: Float64Array, log: (log: any) => void = (a) => {}) {
    var n = rest.length / 2;
    var w = new Float64Array(2 * n);

    var A = 0;
    for (var i = 0; i < n; i++) {
        var ni = (i + 1) % n;
        A += rest[2 * i] * rest[2 * ni + 1] - rest[2 * ni] * rest[2 * i + 1];
    }

    var Aw = Math.sign(A);

    log(Aw);

    for (var i = 0; i < n; i++) {
        var ni = (i + 1) % n;

        var ax = rest[2 * ni] - rest[2 * i];
        var ay = rest[2 * ni + 1] - rest[2 * i + 1];
        var bx = rest[2 * i] - x;
        var by = rest[2 * i + 1] - y;

        var Q = ax * ax + ay * ay;
        var S = bx * bx + by * by;
        var R = 2 * (ax * bx + ay * by);

        var an = Math.sqrt(Q);
        var BA = -Aw * (bx * ay - by * ax);

        var SRT = Math.sqrt(4 * S * Q - (R**2));

        var L0 = Math.log(S);
        var L1 = Math.log(S + Q + R);

        var A0 = Math.atan(R / SRT) / SRT;
        var A1 = Math.atan((2 * Q + R) / SRT) / SRT;

        var A10 = A1 - A0;
        var L10 = L1 - L0;

        var psi = (-1 * an / (4 * Math.PI)) * (
            (4 * S - (R ** 2 / Q)) * A10 +
            (R / (2 * Q)) * L10 +
            L1 - 2
        );
        w[n + i] = psi / an;

        w[ni] = w[ni] - (
            (BA / (2 * Math.PI)) * ((L10/(2*Q)) - (A10 * (R/Q)))
        );

        w[i] = w[i] + (
            (BA / (2 * Math.PI)) * ((L10/(2*Q)) - (A10 * (2 + (R/Q))))
        );
    }

    log(w.subarray(0, n));

    return w;
}

export function deformer(rest: Float64Array, moved: Float64Array, log: (log: any) => void = (a) => {}) {
    var n = moved.length / 2;

    var D = 0;
    for (var i = 0; i < n; i++) {
        var ni = (i + 1) % n;
        D += moved[2 * i] * moved[2 * ni + 1] - moved[2 * ni] * moved[2 * i + 1];
    }

    var Dw = Math.sign(D);

    return (w: Float64Array, out: Float64Array) => {
        var x = 0;
        var y = 0;
        for (var i = 0; i < n; i++) {
            var ni = (i + 1) % n;
            var c = Dw * w[n + i];
            x += w[i] * moved[2 * i] + c * (moved[2 * ni + 1] - moved[2 * i + 1]);
            y += w[i] * moved[2 * i + 1] - c * (moved[2 * ni] - moved[2 * i]);
        }
        out[0] = x;
        out[1] = y;
    };
}
