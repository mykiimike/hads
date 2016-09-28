'use strict';

let Promise = require('bluebird');
let fs = Promise.promisifyAll(require('fs'));
let mkdirpAsync = Promise.promisify(require('mkdirp'));
let path = require('path');
let optimist = require('optimist');
let express = require('express');
let bodyParser = require('body-parser');
let pkg = require('./package.json');
let Matcher = require('./lib/matcher.js');
let Renderer = require('./lib/renderer.js');
let Helpers = require('./lib/helpers.js');
let Indexer = require('./lib/indexer.js');

let args = optimist
  .usage(`\n${pkg.name} ${pkg.version}\nUsage: $0 [root dir] [options]`)
  .alias('p', 'port')
  .describe('p', 'Port number to listen on')
  .default('p', 4040)
  .alias('h', 'host')
  .describe('h', 'Host address to bind to')
  .default('h', 'localhost')
  .alias('o', 'open')
  .boolean('o')
  .describe('o', 'Open default browser on start')
  .describe('help', 'Show this help')
  .argv;

if (args.help || args._.length > 1) {
  optimist.showHelp(console.log);
  process.exit();
}

let docPath = args._[0] || './';
let rootPath = path.resolve(docPath);
let indexer = new Indexer(rootPath);
let renderer = new Renderer(indexer);
let app = express();

app.set('views', path.join(__dirname, '/views'));
app.set('view engine', 'pug');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.use('/_hads/', express.static(path.join(__dirname, '/public')));
app.use('/_hads/highlight/', express.static(path.join(__dirname, 'node_modules/highlight.js/styles')));
app.use('/_hads/octicons/', express.static(path.join(__dirname, 'node_modules/octicons/build/font')));
app.use('/_hads/ace/', express.static(path.join(__dirname, 'node_modules/ace-builds/src-min/')));

const ROOT_FILES = ['index.md', 'README.md', 'readme.md'];
const STYLESHEETS = ['/highlight/github.css', '/octicons/octicons.css', '/css/github.css', '/css/style.css'];
const SCRIPTS = ['/ace/ace.js', '/js/client.js'];

app.get('*', (req, res, next) => {
  let route = Helpers.extractRoute(req.path);
  let query = req.query || {};
  let rootIndex = -1;
  let create = Helpers.hasQueryOption(query, 'create');
  let edit = Helpers.hasQueryOption(query, 'edit') || create;
  let filePath, icon, search, error, title;

  function tryProcessFile() {
    let contentPromise = null;
    filePath = path.join(rootPath, route);

    return fs.statAsync(filePath)
      .then((stat) => {
        search = query.search && query.search.length > 0 ? query.search.trim() : null;

        if (stat.isDirectory() && !search && !error) {
          if (!create) {
            // Try to find a root file
            route = path.join(route, ROOT_FILES[++rootIndex]);
            return tryProcessFile();
          } else {
            route = '/';
            title = 'Error';
            error = `Cannot create file \`${filePath}\``;
          }
        }

        if (error) {
          edit = false;
          contentPromise = Promise.resolve(Renderer.renderMarkdown(error));
          icon = 'octicon-alert';
        } else if (search) {
          contentPromise = renderer.renderSearch(query.search);
          icon = 'octicon-search';
        } else if (Helpers.hasQueryOption(query, 'raw')) {
          // Access raw content: images, code, etc
          return res.sendFile(filePath);
        } else if (Matcher.isMarkdown(filePath)) {
          contentPromise = edit ? renderer.renderRaw(filePath) : renderer.renderFile(filePath);
          icon = 'octicon-file';
        } else if (Matcher.isImage(filePath)) {
          contentPromise = renderer.renderImageFile(route);
          icon = 'octicon-file-media';
        } else if (Matcher.isSourceCode(filePath)) {
          contentPromise = renderer.renderSourceCode(filePath, path.extname(filePath).replace('.', ''));
          icon = 'octicon-file-code';
        }

        if (!title) {
          title = search ? renderer.searchResults : path.basename(filePath);
        }

        if (contentPromise) {
          return contentPromise.then((content) => {
            res.render(edit ? 'edit' : 'file', {
              title: title,
              route: route,
              icon: icon,
              search: search,
              content: content,
              styles: STYLESHEETS,
              scripts: SCRIPTS,
              pkg: pkg
            });
          });
        } else {
          next();
        }
      })
      .catch(() => {
        if (create) {
          let fixedRoute = Helpers.ensureMarkdownExtension(route);
          if (fixedRoute !== route) {
            return res.redirect(fixedRoute + '?create=1');
          }

          return mkdirpAsync(path.dirname(filePath))
            .then(() => fs.writeFileAsync(filePath, ''))
            .then(() => indexer.updateIndexForFile(filePath))
            .catch((e) => {
              console.error(e);
              title = 'Error';
              error = `Cannot create file \`${filePath}\``;
              route = '/';
            })
            .then(tryProcessFile);
        } else if (rootIndex !== -1 && rootIndex < ROOT_FILES.length - 1) {
          route = path.join(path.dirname(route), ROOT_FILES[++rootIndex]);
        } else {
          route = '/';
          title = '404 Error';
          error = '## File not found ¯\\\\\\_(◕\\_\\_◕)_/¯\n> *There\'s a glitch in the matrix...*';
        }
        return tryProcessFile();
      });
  }

  tryProcessFile();
});

app.post('*', (req, res, next) => {
  let route = Helpers.extractRoute(req.path);
  let filePath = path.join(rootPath, route);

  fs.statAsync(filePath)
    .then((stat) => {
      if (stat.isFile() && req.body.content) {
        return fs.writeFileAsync(filePath, req.body.content);
      }
    })
    .then(() => {
      indexer.updateIndexForFile(filePath);
      return renderer.renderFile(filePath);
    })
    .then((content) => {
      res.render('file', {
        title: path.basename(filePath),
        route: route,
        icon: 'octicon-file',
        content: content,
        styles: STYLESHEETS,
        scripts: SCRIPTS,
        pkg: pkg
      });
    })
    .catch(() => {
      next();
    })
});

indexer.indexFiles().then(() => {
  app.listen(args.port, args.host, () => {
    let serverUrl = `http://${args.host}:${args.port}`;
    console.log(`${pkg.name} ${pkg.version} serving at ${serverUrl} (press CTRL+C to exit)`);

    if (args.open) {
      require('open')(serverUrl);
    }
  });
});