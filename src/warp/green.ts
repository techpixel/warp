import { Vector2D } from "../vector.lib";

export function interp(point: Vector2D, icage: Vector2D[], dcage: Vector2D[], log: (log: any) => void = (a) => {}) {
    var phi: number[] = new Array(icage.length).fill(0);
    var psi: number[] = new Array(icage.length).fill(0);

    var A = 0;
    var D = 0;
    for (var i = 0; i < icage.length; i++) {
        var ni = (i + 1) % icage.length;
        A += icage[i].i * icage[ni].j - icage[ni].i * icage[i].j;
        D += dcage[i].i * dcage[ni].j - dcage[ni].i * dcage[i].j;
    }
    
    var Aw = Math.sign(A);
    var Dw = Math.sign(D);

    log(Aw);

    for (var i = 0; i < icage.length; i++) {
        var ni = (i + 1) % icage.length;

        var a = icage[ni].sub(icage[i]);
        var b = icage[i].sub(point);
        
        var Q = a.dot(a);
        var S = b.dot(b);
        var R = a.scale(2).dot(b);

        var n = (new Vector2D(Aw * a.j, -1 * Aw * a.i)).scale(1 / a.norm());
        var BA = b.dot(n.scale(a.norm())) * -1;
        // var BA = b.det(a);

        var SRT = Math.sqrt(4 * S * Q - (R**2));

        var L0 = Math.log(S);
        var L1 = Math.log(S + Q + R);

        var A0 = Math.atan(R / SRT) / SRT;
        var A1 = Math.atan((2 * Q + R) / SRT) / SRT;

        var A10 = A1 - A0;
        var L10 = L1 - L0;

        psi[i] = (-1 * a.norm() / (4 * Math.PI)) * (
            (4 * S - (R ** 2 / Q)) * A10 +
            (R / (2 * Q)) * L10 +
            L1 - 2
        )
        phi[ni] = phi[ni] - (
            (BA / (2 * Math.PI)) * ((L10/(2*Q)) - (A10 * (R/Q)))
        );

        phi[i] = phi[i] + (
            (BA / (2 * Math.PI)) * ((L10/(2*Q)) - (A10 * (2 + (R/Q))))
        );
    }

    var cb = new Vector2D();
    for (var i = 0; i < icage.length; i++) {
        cb = cb.add(dcage[i].scale(phi[i]));
    }

    var kb = new Vector2D();
    for (var i = 0; i < icage.length; i++) {
        var ni = (i + 1) % icage.length;
        var a = dcage[ni].sub(dcage[i]);
        var n = (new Vector2D(Dw * a.j, -1 * Dw * a.i)).scale(1 / a.norm());
        var sj = dcage[i].dist(dcage[ni]) / icage[i].dist(icage[ni]); 
        kb = kb.add(n.scale(psi[i]).scale(sj));
    }    

    log(phi);

    return cb.add(kb);
}
