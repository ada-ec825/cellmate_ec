## Homework - Implement improved Euler and compare with forward Euler

Consider the simple scalar equation

y'(t) = y,   y(0) = 1.

Implement the forward Euler and improved Euler schemes and use them to approximate solutions of this equation for different values of dt. Plot the solutions over the time interval [0, 2*pi].

Write a function `approx_error(f, y0, t0, t, h)` that returns the approximation error at a given time t for both methods.

Using a while loop, compute the error at t=3 for dt from 1 to 10^-5, and plot it against dt in logarithmic scale.

Use `numpy.polyfit` to compute a line of best fit to the logs of the data and hence conclude the order of accuracy of both methods.

You should observe that improved Euler is much better than forward Euler - plot the error as a function of time (suggest you use a semilogy in matplotlib to get a log axis on the y axis, but plot the x (time) axis normally.

See if you can get `scipy.integrate.odeint` working for this problem and see how its errors compare as a function of time - hint: take note of the order that odeint assumes the function f takes the arguments t and y, you can pass the argument `tfirst=True` to tell it to assume an order consistent with what convention we assume.
