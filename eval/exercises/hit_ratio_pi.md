#### Estimating pi from raindrops

A square tile of side 1 is left out in the rain. Consider the quarter disc of
radius 1 that touches two of the tile's edges. Because raindrops land at random
positions spread evenly over the tile, the share of drops that land inside the
quarter disc tells you the ratio between the two areas, and hence gives an
estimate of pi:

pi is approximately 4 * (drops inside) / (drops in total).

Use `nparray`s to estimate pi from simulated rainfall as follows:
1. Fix a number of drops `n`.
2. Draw the horizontal positions of all n drops at random from 0 up to 1.
3. Draw their vertical positions the same way.
4. Work out how many drops satisfy x^2 + y^2 < 1.
5. Turn that count into an estimate of pi.
6. Repeat for several values of `n`, reporting how far each estimate falls from
   the true value.

Name the function you write `estimate_pi(n)`, where `n` is the number of drops.
