## Example 3: Designing your own class

### Problem Statement

The final problem is always the most challenging: designing your own class from scratch. We'll give you a problem statement, and you'll need to design a class to solve it. The problem statement is as follows:

Build a class to represent the data provided from a [weather station](https://en.wikipedia.org/wiki/Weather_station). The station has the following fixed data attached to it:
- A name (a string)
- A location (a tuple of two floats, representing the latitude and longitude)
- A height above sea level (a float, representing the height in meters)

The station also has (at a minimum) the following data that change over time:

- A temperature (a float, representing the temperature in degrees Celsius)
- A humidity (a float, representing the humidity as a percentage)
- The pressure (a float, representing the pressure in hPa)

The class should have methods to do the following:

- An initialisation method (`__init__`) that takes the name, location, and height above sea level as arguments, and stores them, as well as doing some initialisation of the temperature, humidity and pressure (plus other variables if you've added them).
- A method to update the temperature, humidity, and pressure.
- Appropriately implemented `__str__` and `__repr__` methods.
- Methods to calculate appropriate "weather" metrics, such as the [dew point](https://en.wikipedia.org/wiki/Dew_point) (it's ok to use the simplified formula), the [heat index](https://en.wikipedia.org/wiki/Heat_index), and so on, and to convert between different temperature scales (e.g. Celsius, Fahrenheit, Kelvin). You may want to make use of the `@property` decorator to make these methods feel like attributes to the user.
