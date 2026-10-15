import { Vector2D } from "../vector.lib";

// ai generated perspective correction of the mvc

function normalize(pts: Vector2D[]): Vector2D[] {
    var c = pts.reduce((a, q) => a.add(q), new Vector2D()).scale(1 / pts.length);
    var d = pts.reduce((a, q) => a + q.dist(c), 0) / pts.length;
    var s = d > 0 ? Math.SQRT2 / d : 1;
    return pts.map((q) => q.sub(c).scale(s));
}

function solve(A: number[][], b: number[]): number[] | null {
    var n = b.length;
    var M = A.map((row, r) => [...row, b[r]]);
    for (var c = 0; c < n; c++) {
        var p = c;
        for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return null;
        [M[c], M[p]] = [M[p], M[c]];
        for (var r = c + 1; r < n; r++) {
            var f = M[r][c] / M[c][c];
            for (var k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }

    var x: number[] = new Array(n);
    for (var r = n - 1; r >= 0; r--) {
        var acc = M[r][n];
        for (var k = r + 1; k < n; k++) acc -= M[r][k] * x[k];
        x[r] = acc / M[r][r];
    }
    return x;
}

function homography(src: Vector2D[], dst: Vector2D[]): number[] | null {
    var MtM = Array.from({ length: 8 }, () => new Array(8).fill(0));
    var Mtb = new Array(8).fill(0);
    var add = (row: number[], rhs: number) => {
        for (var r = 0; r < 8; r++) {
            Mtb[r] += row[r] * rhs;
            for (var c = 0; c < 8; c++) MtM[r][c] += row[r] * row[c];
        }
    };

    for (var k = 0; k < src.length; k++) {
        var x = src[k].i, y = src[k].j, u = dst[k].i, v = dst[k].j;
        add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
        add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
    }
    return solve(MtM, Mtb);
}

function depths(icage: Vector2D[], dcage: Vector2D[]): number[] {
    var flat = icage.map(() => 1);
    if (icage.length < 4) return flat; 

    var src = normalize(icage);
    var H = homography(src, normalize(dcage));
    if (!H) return flat;

    var z = src.map((q) => H![6] * q.i + H![7] * q.j + 1);
    if (!z.every((zi) => Number.isFinite(zi) && zi > 1e-9)) return flat;
    return z;
}

export function interp(point: Vector2D, icage: Vector2D[], dcage: Vector2D[], log: (log: any) => void = (a) => {}) {
    var s: Vector2D[] = [];
    var r: number[] = [];
    var A: number[] = [];
    var D: number[] = [];
    var z = depths(icage, dcage);

    log({ z });

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

            var wi = r[ni] * z[i];
            var wn = r[i] * z[ni];
            var itm = dcage[i].scale(wi).add(dcage[ni].scale(wn));

            return itm.scale(1/(wi+wn));
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
        w = w * z[i];
        f = f.add(dcage[i].scale(w));
        W = W + w;
    }

    return f.scale(1/W);
}
