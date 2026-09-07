const { getDefaultConfig } = require('expo/metro-config');  
const path = require('path');

const config = getDefaultConfig(__dirname);  

config.resolver.assetExts.push('onnx');  

const emptyShim = path.resolve(__dirname, 'src/shims/emptyNodeModule.js');
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  fs: emptyShim,
  path: emptyShim,
};

module.exports = config; 

