'use strict';
const { suffix } = require('./deep.js');
module.exports = { greet: (name) => `hello ${name}${suffix}` };
