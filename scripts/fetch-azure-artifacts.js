const github = require("@actions/github");
const https = require("https");
const url = require("url");
const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");
const crypto = require("crypto");
const pesyConfig = require("../package.json").pesy;

let githubRef = process.env.GITHUB_REF;
let githubRepository = process.env.GITHUB_REPOSITORY; // contains org too. Eg octocat/Hello Ref: https://docs.github.com/en/actions/reference/environment-variables#default-environment-variables
let [owner, repo] = githubRepository.split("/");

let restBase = `https://dev.azure.com/${pesyConfig["azure-project"]}`;
let os = "";

switch (process.platform) {
  case "linux":
    os = "Linux";
    break;
  case "darwin":
    os = "Darwin";
    if (process.arch == "arm64") {
      os += "-arm64";
    }
    break;
  case "win32":
    os = "Windows_NT";
    break;
}

let artName = `Cache-${os}-install-v1`;
let artChecksum = `${artName}-checksum`;
let prefix = `branchName=refs%2Fheads%2F`;
let branch = `${prefix}master`;
let filter = `deletedFilter=excludeDeleted&statusFilter=completed`; //&resultFilter=succeeded`;
let latest = "finishTimeDescending&$top=1";
let definition = "esy.pesy-reason-template";
let getDefinitionIDUrl = `${restBase}/_apis/build/definitions?name=${definition}&api-version=4.1`;

// To disambiguate cached artifacts based on github project name. Because it's possible that more than one repo
// is tied to the same project on Azure

function curl(urlStr, data, headers) {
  // console.log("DEBUG", url);
  return new Promise(function (resolve, reject) {
    let request = https.request(
      urlStr,
      Object.assign({}, headers ? { headers } : {}, {
        method: data ? "POST" : "GET",
      }),
      function (response) {
        let buffer = "";
        response.on("data", function (chunk) {
          buffer += chunk;
        });
        response.on("end", function () {
          resolve(JSON.parse(buffer));
        });
        response.on("error", function (error) {
          reject(error);
        });
      }
    );
    if (data) {
      request.write(data);
    }
    request.end();
  });
}

function fetch(urlStr, urlObj, pathStr, callback) {
  let httpm;
  switch (urlObj.protocol) {
    case "http:":
      httpm = require("http");
      break;
    case "https:":
      httpm = require("https");
      break;
    default:
      throw `Unrecognised protocol in provided url: ${urlStr}`;
  }
  httpm.get(urlObj, function (response) {
    if (response.statusCode == 302) {
      let urlStr = response.headers.location;
      fetch(urlStr, url.parse(urlStr), pathStr, callback);
    } else if (response.statusCode == 404) {
      let buffer = "";
      response.on("data", function (chunk) {
        buffer += chunk;
      });
      response.on("end", function () {
        callback(JSON.parse(buffer));
      });
    } else {
      response.pipe(fs.createWriteStream(pathStr)).on("finish", function () {
        callback(null, pathStr);
      });
    }
  });
}

function download(urlStrWithChecksum) {
  return new Promise(function (resolve, reject) {
    let [urlStr, checksum] = urlStrWithChecksum.split("#");
    if (!url) {
      reject(`No url in ${urlStr}`);
    } else if (!checksum) {
      reject(`No checksum in ${urlStr}`);
    }

    let [algo, hashStr] = checksum.split(":");
    if (!hashStr) {
      hashStr = algo;
      algo = "sha1";
    }

    function computeChecksum(filePath) {
      return new Promise((resolve, reject) => {
        let stream = fs
          .createReadStream(filePath)
          .pipe(crypto.createHash(algo));
        let buf = "";
        stream.on("data", (chunk) => {
          buf += chunk.toString("hex");
        });
        stream.on("end", () => {
          resolve(buf);
        });
      });
    }
    let urlObj = url.parse(urlStr);
    let filename = path.basename(urlObj.path);
    let tmpDownloadedPath = path.join(os.tmpdir(), "esy-package-" + filename);
    if (fs.existsSync(tmpDownloadedPath)) {
      computeChecksum(tmpDownloadedPath).then((checksum) => {
        if (hashStr == checksum) {
          resolve(tmpDownloadedPath);
        } else {
          fetch(urlStr, urlObj, tmpDownloadedPath, (_err, _path) =>
            computeChecksum(tmpDownloadedPath).then((checksum) => {
              if (hashStr == checksum) {
                resolve(tmpDownloadedPath);
              } else {
                reject(`Checksum error: expected ${hashStr} got ${checksum}`);
              }
            })
          );
        }
      });
    } else {
      fetch(urlStr, urlObj, tmpDownloadedPath, (_err, _path) =>
        computeChecksum(tmpDownloadedPath).then((checksum) => {
          if (hashStr == checksum) {
            resolve(tmpDownloadedPath);
          } else {
            reject(`Checksum error: expected ${hashStr} got ${checksum}`);
          }
        })
      );
    }
  });
}

function shaFile(path, algo) {
  return new Promise((resolve, reject) => {
    const shasum = crypto.createHash(algo);
    let s = fs.ReadStream(path);
    s.on("data", function (data) {
      shasum.update(data);
    });

    s.on("end", function () {
      var hash = shasum.digest("hex");
      resolve(hash.trim());
    });
    s.on("error", function (error) {
      reject(error);
    });
  });
}

curl(getDefinitionIDUrl)
  .then((response) => {
    if (response.count > 1) {
      return Promise.reject("More than one definition IDs returned");
    } else {
      let {
        value: [{ id: defintionID }],
      } = response;
      return curl(
        `${restBase}/_apis/build/builds?${filter}&${branch}&${latest}&definitions=${defintionID}&api-version=4.1`
      );
    }
  })
  .then((response) => {
    if (response.count > 1) {
      return Promise.reject("More than one build IDs returned as 'latest'");
    } else {
      let {
        value: [{ id: buildID }],
      } = response;
      console.log("Downloading ", artName);
      return Promise.all([
        curl(
          `${restBase}/_apis/build/builds/${buildID}/artifacts?artifactName=${artName}&api-version=4.1`
        ),
        curl(
          `${restBase}/_apis/build/builds/${buildID}/artifacts?artifactName=${artChecksum}&api-version=4.1`
        ),
      ]);
    }
  })
  .then(([artResponse, artChecksumResponse]) => {
    let {
      resource: { downloadUrl: artDownloadUrl },
    } = artResponse;
    let {
      resource: { downloadUrl: artChecksumDownloadUrl },
    } = artChecksumResponse;
    return Promise.all([
      new Promise(function (resolve, reject) {
        let urlStr = artDownloadUrl;
        let urlObj = url.parse(urlStr);
        fetch(
          urlStr,
          urlObj,
          path.join(process.cwd(), "art.zip"),
          (err, path) => (err ? reject(err) : resolve(path))
        );
      }),
      new Promise(function (resolve, reject) {
        let urlStr = artChecksumDownloadUrl;
        let urlObj = url.parse(urlStr);
        fetch(
          urlStr,
          urlObj,
          path.join(process.cwd(), "checksum.zip"),
          (err, path) => (err ? reject(err) : resolve(path))
        );
      }),
    ]);
  })
  .then(([artPath, artChecksumPath]) => {
    childProcess.execSync(`unzip -j -o ${artPath}`);
    childProcess.execSync(`unzip -j -o ${artChecksumPath}`);
    console.log(artPath);
    console.log(artChecksumPath);
    let expectedChecksum = fs
      .readFileSync(path.join(path.dirname(artChecksumPath), "checksum.txt"))
      .toString()
      .trim();
    let cacheZip = "cache.zip";
    let checksumTxt = "checksum.txt";
    return shaFile(cacheZip, "sha256").then((zipFileChecksum) => {
      if (zipFileChecksum === expectedChecksum) {
        fs.renameSync(cacheZip, `${artName}.zip`);
        fs.renameSync(checksumTxt, `${artChecksum}.txt`);
        const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
        return octokit.repos
          .getReleaseByTag({
            owner,
            repo,
            tag: githubRef.replace("refs/tags/", ""),
          })
          .then((response) => {
            if (response.status != 200) {
              return Promise.reject(response);
            }
            let { upload_url } = response.data;
            console.log(upload_url);
            console.log(response);
            const contentLength = (filePath) => fs.statSync(filePath).size;
            const checksumFileHeaders = {
              "content-type": "text/plain",
              "content-length": contentLength(`${artChecksum}.txt`),
            };
            const artFileHeaders = {
              "content-type": "application/zip",
              "content-length": contentLength(`${artName}.zip`),
            };
            const artFileName = artName;
            const checksumFileName = artChecksum;
            const checksumFileData = fs.readFileSync(`${artChecksum}.txt`);
            const artFileData = fs.readFileSync(`${artName}.zip`);
            console.log("Uploading...");
            let upload = (upload_url, headers, name, data) =>
              octokit.repos.uploadReleaseAsset({
                url: upload_url,
                headers,
                name,
                data,
              });
            return Promise.all([
              upload(
                upload_url,
                checksumFileHeaders,
                checksumFileName,
                checksumFileData
              ).then((uploadAssetResponse) => {
                const {
                  data: { browser_download_url: browserDownloadUrl },
                } = uploadAssetResponse;
                console.log(browserDownloadUrl);
              }),
              upload(upload_url, artFileHeaders, artFileName, artFileData).then(
                (uploadAssetResponse) => {
                  const {
                    data: { browser_download_url: browserDownloadUrl },
                  } = uploadAssetResponse;
                  console.log(browserDownloadUrl);
                }
              ),
            ]);
          });
      } else {
        console.log("Checksum mismatch");
        process.exit(-1);
      }
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
