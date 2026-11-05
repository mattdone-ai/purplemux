'use strict';
const path = require('path');
const { greet } = require('./greet');
const lazy = () => require("./lazy-helper.js");
const late = () => require(`./late`);
process.stdout.write(`${greet(path.basename(__filename))} ${lazy().name} ${late().name}\n`);
