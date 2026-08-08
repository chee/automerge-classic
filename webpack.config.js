const path = require('path')

const common = {
  mode: 'production',
  devtool: 'source-map',
  module: {rules: []},
  target: 'browserslist:web'
}

function moduleConfig(entry, filename) {
  return Object.assign({}, common, {
    entry,
    experiments: {outputModule: true},
    output: {
      filename,
      library: {type: 'module'},
      path: path.resolve(__dirname, 'dist'),
      chunkLoading: false,
      module: true
    }
  })
}

module.exports = [Object.assign({}, common, {
  entry: './src/automerge.js',
  output: {
    filename: 'automerge.js',
    library: 'Automerge',
    libraryTarget: 'umd',
    path: path.resolve(__dirname, 'dist'),
    // https://github.com/webpack/webpack/issues/6525
    globalObject: 'this',
    // https://github.com/webpack/webpack/issues/11660
    chunkLoading: false,
  }
}), moduleConfig('./src/automerge.mjs', 'automerge.mjs'), moduleConfig('./src/classic.mjs', 'classic.mjs')]
