import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  outfile: 'app.bundle.js',
  sourcemap: true,
  minify: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching for changes …');
} else {
  await esbuild.build(options);
}
