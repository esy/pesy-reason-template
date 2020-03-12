# morph_pesy_template

A project which demonstrates a Reason workflow with [Esy][].

[esy]: https://github.com/esy/esy

## Usage

You need Esy, you can install the beta using [npm](https://npmjs.com):

    % npm install -g esy@latest

> NOTE: Make sure `esy --version` returns at least `0.5.8` for this project to build.

Then run the `esy` command from this project root to install and build depenencies.

    % esy

You can start the server to try it out (runs `scripts.start` specified in
`package.json`):

    % esy start

This will start a simple server that runs on port 8080 and has the following routes:

    / -> responds with "Hello world!"
    /greet/:name -> responds with "Hello ${name}!"
    /static/path/to/file -> responds with the file

After you make some changes to source code, you can re-run project's build
again with the same simple `esy` command.

    % esy

And test compiled executable (runs `scripts.tests` specified in
`package.json`):

    % esy test

Documentation for the libraries in the project can be generated with:

    % esy doc
    % open-cli `esy echo '#{self.target_dir}/default/_doc/_html/index.html'`

This assumes you have a command like [open-cli](https://github.com/sindresorhus/open-cli) installed on your system.
