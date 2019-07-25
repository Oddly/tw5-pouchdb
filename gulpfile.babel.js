/********************************************************************
 * README
 ********************************************************************
 *
 * This gulp file bundles a tiddlywiki plugin folder as a tid file
 * that may be installed in a wiki using drag & drop. In production
 * mode, all styles and scripts are uglified and docs are produced.
 *
 * ------------------------------------------------------------------
 *
 * Usage: gulp [OPTION...]
 *
 * Options:
 *   --production    Run in production mode
 *   --mode          The mode of the compilation, e.g. "develop" or
 *                   "testing". The mode will be inserted into
 *                   the version string (e.g. "1.2.5-develop+371").
 *                   Exception: If mode is "master", then it will
 *                   be ignored and not added to the version string.
 *
 * ------------------------------------------------------------------
 *
 * The following directory structure is required by the script:
 *
 * src
 * ├── plugins
 * │   └── <author>
 * │       └── <pluginname>
 * │           ├── plugin.info
 * │           └── * // all further plugin files and folders
 * └── jsdoc
 *     └── * // jsdoc settings
 *
 * ------------------------------------------------------------------
 *
 * The following output is produced
 *
 * dist
 * └── <author>
 *     └── <pluginname>
 *         ├── plugin.info
 *         └── * // compiled plugin files
 *
 * bundle
 * └── <pluginname>_<version>.json // bundled plugin for drag & drop
 *
 * docs
 * └── * // docs generated by jsdoc
 *
 *******************************************************************/

/**** Script config ************************************************/

// the author and pluginname; lowercase letters and no spaces!
const authorName = 'danielo515';
const pluginName = 'pouchdb';

// whether or not to create/increment the build number automatically
const isIncrBuild = true;

/**** Imports ******************************************************/

// native node modules

import path from 'path';
import fs from 'fs';

// packages

import TiddlyWiki from 'tiddlywiki';
import { argv } from 'yargs';
import del from 'del';
import exists from 'is-there'; // why on earth is fs.exists depreciated anyway by node?
import SemVer from 'semver';
import runSequence from 'run-sequence'; // once gulp 4.0 is out: remove runSequence and update
import beep from 'beepbeep';
import gulp from 'gulp';
import gulpif from 'gulp-if';
import babel from 'gulp-babel';
import uglify from 'gulp-uglify';
import jsdoc from 'gulp-jsdoc3';
import esprima from 'gulp-esprima';
import debug from 'gulp-debug';
import bump from 'gulp-bump';
import sourcemaps from 'gulp-sourcemaps';

/**** Preprocessing ************************************************/

const pluginSrc = './src/plugins/';
const pluginNamespace = `${authorName}/${pluginName}`; // no trailing slash!
const pluginTiddler = `$:/plugins/${pluginNamespace}`;
const pluginInfoPath = path.resolve(pluginSrc, pluginNamespace, 'plugin.info');
const pluginInfo = JSON.parse(fs.readFileSync(pluginInfoPath, 'utf8'));

// build paths where we output our results
const outPath = {
  bundle: './bundle/',
  dist: './dist/',
  docs: './docs/',
  maps: './maps/'
};

// a quick sanity check
if (pluginTiddler !== pluginInfo.title) {
  throw new Error('Gulp settings do not match the plugin.info');
}

/**** Tasks ********************************************************/

/**
 * Remove all output paths.
 */
gulp.task('perform cleanup', () => {

  const cleanupPaths = [];
  for (let path in outPath) {
    cleanupPaths.push(outPath[path]);
  }

  return del(cleanupPaths, { force: true });

});

/**
 * Override the version of the plugin specified in the plugin.info
 * file. If `isIncrBuild` is true, then the build number is
 * incremented as well.
 */
gulp.task('bump version', (cb) => {

  // bump plugin info
  const v = new SemVer(pluginInfo.version);
  const build = (isIncrBuild ? '+' + (parseInt(v.build[0] || 0) + 1) : '');
  const mode = (argv.mode && argv.mode !== 'master' ? `-${argv.mode}` : '');
  const version = `${v.major}.${v.minor}.${v.patch}${mode}`;
  pluginInfo.version = version + build;
  pluginInfo.released = new Date().toUTCString();
  fs.writeFileSync(pluginInfoPath, JSON.stringify(pluginInfo, null, 2));

  // bump package.json
  gulp.src('./package.json')
      .pipe(bump({ key: 'version', version: version }))
      .pipe(gulp.dest('./'));

  cb();

});

/**
 * Copy everything that doesn't need further processing to the
 * dist directory
 */
gulp.task('copy vanilla files', () => {

  return gulp.src(pluginSrc + '/**/!(*.scss|*.js)')
             .pipe(gulp.dest(outPath.dist));

});

/**
 * Will uglify the js code if in production mode and move the
 * files to the dist directory.
 *
 * Note: We do not tell uglify to do any code optimization, as
 * this caused troubles in the past.
 */
gulp.task('compile and move scripts', () => {

  const uglifyOpts = {
    compress: false, // no further optimization
    preserveComments: 'some',
  };

  const sourceMapOpts = {
    destPath: outPath.maps,
    sourceMappingURLPrefix: '.'
  };

  return gulp.src(pluginSrc + '/**/*.js')
    .pipe(sourcemaps.init())
    .pipe(babel())
    .pipe(gulpif (argv.production, uglify(uglifyOpts)))
    .pipe(sourcemaps.write('./maps', sourceMapOpts))
    .pipe(gulp.dest(outPath.dist));

});

/**
 * Syntax validation.
 * @see http://esprima.org/doc/
 */
gulp.task('Javascript validation', () => {

  return gulp.src(pluginSrc + '/**/*.js')
             .pipe(debug())
             .pipe(esprima({ sourceType: 'module' }));

});

/**
 * Create the docs if in production mode.
 */
gulp.task('create docs', (cb) => {

  // use require to load the jsdoc config;
  // note the extension is discarted when loading json with require!
  const config = require('./src/jsdoc/config');
  config.opts.destination = outPath.docs;

  gulp.src([ pluginSrc + '/**/*.js', './src/jsdoc/README.md' ])
      .pipe(jsdoc(config, cb));

});

/**
 * Basically what we are doing now is to move all compiled plugin
 * files in the plugin directory of the tiddlywiki node module,
 * then start a tiddlywiki instance to load and pack the plugin as
 * json tiddler and then save it to the filesystem into the bundle
 * dir.
 */
gulp.task('bundle the plugin', (cb) => {

  // init the tw environment
  const $tw = TiddlyWiki.TiddlyWiki();

  // set the output to verbose;
  // Attention: argv always needs to contain at least one element,
  // otherwise the wiki instance will issue a help output.
  // @see https://github.com/Jermolene/TiddlyWiki5/issues/2238
  $tw.boot.argv = [
    '--verbose'
  ];

  // trigger the startup; since we are not in a browser environment,
  // we need to call boot() explicitly.
  $tw.boot.boot();

  // bundle from the plugin files as json
  const plugin = $tw.loadPluginFolder(path.resolve(outPath.dist, pluginNamespace));

  //make sure the bundle path exists
  if (!exists(outPath.bundle)) fs.mkdirSync(outPath.bundle);

  // write the json to the dist dir;
  // note: tw requires the json to be wrapped in an array, since
  // a collection of tiddlers are possible.
  const outName = pluginName + '_' + pluginInfo.version + '.json';
  fs.writeFileSync(path.resolve(outPath.bundle, outName),
                   JSON.stringify([ plugin ], null, 2));

  beep();

  cb();

});

/**
 * Execute the default task.
 */
gulp.task('default', (cb) => {

  runSequence(
    'bump version',
    cb
  );

});
