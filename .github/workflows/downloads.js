#!/bin/env node

var counts = require( 'npm-package-download-counts' );
var got = require('got');
 
const verified = got.get('https://raw.githubusercontent.com/homebridge/verified/downloads-test/verified-plugins.json').json();

var opts = {
    'packages': verified,
    'period': 'last-month'
};

 
counts( opts );
