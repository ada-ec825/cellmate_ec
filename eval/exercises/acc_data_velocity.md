## Exercise 3.9: Read acceleration data and find velocities

A file `data/acc.dat` contains measurements $a_0, a_1, \ldots, a_{n-1}$ of the
acceleration of an object moving along a straight line. The measurement $a_k$ is
taken at time point $t_k = k \Delta t$, where $\Delta t$ is the time spacing
between the measurements. The exercise aims to load the acceleration data into a
program and compute the velocity $v(t)$ of the object at some time $t$.

In general, the acceleration $a(t)$ is related to the velocity $v(t)$ through
$v^\prime(t) = a(t)$. This means that

$$v(t) = v(0) + \int_0^t{a(\tau)d\tau}.$$

If $a(t)$ is only known at some discrete, equally spaced points in time
(which is the case in this exercise), we must compute the integral above
numerically, for example, using the Trapezoidal rule:

$$v(t_k) \approx v(0) + \Delta t \left(\frac{1}{2}a_0 + \frac{1}{2}a_k + \sum_{i=1}^{k-1}a_i \right), \ \ 1 \leq k \leq n-1.$$

We assume $v(0) = 0$, so $v_0 = 0$. Read the values $a_0, \ldots, a_{n-1}$ from
file into an array `acc_array` and plot the acceleration versus time for
$\Delta t = 0.5$. The time should be stored in an array named `time_array`.

Then write a function `compute_velocity(dt, k, a)` that takes as arguments a
time interval $\Delta t$ as `dt`, an index `k`, and a list of accelerations `a`.
The function uses the Trapezoidal rule to compute one $v(t_k)$ value and return
this value. Experiment with different values of $\Delta t$ and `k`.