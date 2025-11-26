#!/bin/sh

# install node modules
npm install

# Install playwright and its dependencies
npx -y playwright@latest install --with-deps chromium
