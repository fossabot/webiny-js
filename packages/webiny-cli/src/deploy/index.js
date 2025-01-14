import { homedir } from "os";
import path from "path";
import { blue, grey } from "chalk";
import fs from "fs-extra";
import get from "lodash.get";
import inquirer from "inquirer";
import execa from "execa";
import archiver from "archiver";
import tempdir from "temp-dir";
import WebinyCloudSDK from "../sdk/client";
import createLogger from "../logger";
import listPackages from "../utils/listPackages";

const home = homedir();
const webinyConfigPath = path.join(home, ".webiny", "config");
const projectConfigPath = path.resolve(".webiny");
const ui = new inquirer.ui.BottomBar();

export default class Deploy {
    siteId = null;
    accessToken = null;
    sdk = null;
    logger = createLogger();
    packages = {};

    validateCiRequirements() {
        const { WEBINY_ACCESS_TOKEN, WEBINY_SITE_ID } = process.env;
        if (!WEBINY_ACCESS_TOKEN) {
            this.logger.error("WEBINY_ACCESS_TOKEN is not set!");
            process.exit(1);
        }
        if (!WEBINY_SITE_ID) {
            this.logger.error("WEBINY_SITE_ID is not set!");
            process.exit(1);
        }
    }

    async deploy({ name, ...opts }) {
        if (opts.ci) {
            this.validateCiRequirements();
        }

        await this.setupSDK();

        // check if this project has been deployed previously
        // if not - show list of available sites
        // when selected - store site id into the `{projectRoot}/.webiny` file
        this.siteId = this.getSiteId();
        if (!this.siteId) {
            const { siteId } = await this.askForSite();
            this.siteId = siteId;
            this.storeSiteId(siteId);
        }

        // Find all Webiny packages
        const packages = await listPackages();

        if (name) {
            const pkg = packages.find(p => p.name === name);
            const deploy = await this.deployPackage(pkg);
            if (!deploy) {
                return;
            }

            this.logger.log("Activating new deploy...\n");
            await this.sdk.activateDeploy(deploy.id);
            const url = await this.waitTillActive(deploy);
            if (!url) {
                this.logger.error(
                    `Deploy activation failed. Please retry your deploy one more time, then contact Webiny support.`
                );
                process.exit(1);
            }
            this.logger.success("Deploy completed!\n");
            this.logger.info(`Open ${blue(url)} to see your newly deployed app!`);
        } else {
            // Create deploys for each app
            const deploys = {};
            for (let i = 0; i < packages.length; i++) {
                const pkg = packages[i];
                console.log();
                this.logger.log(`Deploying ${blue(pkg.name)} ${grey(`(${pkg.root})`)}`);
                const deploy = await this.deployPackage(pkg);
                if (!deploy) {
                    continue;
                }

                deploys[pkg.name] = deploy;
            }

            if (!Object.keys(deploys).length) {
                process.exit();
            }

            this.logger.success("Deploys created successfully!");

            // Activate deploys
            const folders = Object.keys(deploys);
            for (let i = 0; i < folders.length; i++) {
                const deploy = deploys[folders[i]];
                this.logger.log(`Activating ${blue(folders[i])}...`);
                await this.sdk.activateDeploy(deploy.id);
                const url = await this.waitTillActive(deploy);
                if (!url) {
                    this.logger.error(
                        `Deploy activation failed. Please retry your deploy one more time, then contact Webiny support.`
                    );
                    process.exit(1);
                }

                deploys[folders[i]].url = url;
            }

            this.logger.success("Deploy process completed!\n");
            this.logger.info(`Your apps/functions were deployed to these URLs:`);
            Object.values(deploys).forEach(deploy => {
                this.logger.log(deploy.url);
            });

            process.exit();
        }
    }

    async waitTillActive(deploy) {
        for (let i = 0; i < 10; i++) {
            await this.sleep(5000);
            const { active, url } = await this.sdk.isDeployActive(deploy.id);
            if (active) {
                return url;
            }
        }
        return null;
    }

    sleep(millis) {
        return new Promise(resolve => setTimeout(resolve, millis));
    }

    async deployPackage(pkg) {
        // Ensure `build` folder exists
        try {
            await this.ensureBuild(pkg);
        } catch (err) {
            this.logger.error(err);
            process.exit(1);
        }

        return pkg.type === "app" ? await this.deployApp(pkg) : await this.deployFunction(pkg);
    }

    async deployApp(pkg) {
        const buildPath = path.join(pkg.root, "build");
        // create checksums for all files in the `build` folder
        this.logger.log(`Preparing deploy files...`);
        const files = await this.sdk.getFilesDigest(buildPath);

        // call API to create a new deploy record
        this.logger.log(`Creating a new deploy...`);
        try {
            const deploy = await this.sdk.createDeploy(this.siteId, pkg.type, pkg.path, files, {
                ssr: Boolean(pkg.ssr)
            });

            this.logger.log("Uploading files (only new and modified files will be uploaded)...");
            await this.uploadFiles(deploy, files);

            return deploy;
        } catch (err) {
            this.checkNetworkError(err);
            this.logger.info(err.message);
            if (err.code !== "NO_CHANGES_DETECTED") {
                process.exit(1);
            }

            return null;
        }
    }

    async deployFunction(pkg) {
        const buildPath = path.join(pkg.root, "build");
        // create checksums for all files in the `build` folder
        this.logger.log(`Preparing deploy files...`);

        // create a file to stream archive data to.
        const zipFile = path.join(tempdir, "function.zip");
        await this.createZip(buildPath, zipFile);

        // call API to create a new deploy record
        this.logger.log(`Creating a new deploy...`);
        try {
            const zipHash = await this.sdk.getFileHash(zipFile);
            const files = [
                { key: "function.zip", hash: zipHash, abs: zipFile, type: "application/zip" }
            ];

            const deploy = await this.sdk.createDeploy(this.siteId, pkg.type, pkg.path, files);

            this.logger.log("Uploading function...");
            await this.uploadFiles(deploy, files);

            return deploy;
        } catch (err) {
            this.checkNetworkError(err);
            this.logger.info(err.message);
            if (err.code !== "NO_CHANGES_DETECTED") {
                process.exit(1);
            }

            return null;
        }
    }

    async uploadFiles(deploy, files: Array<Object>) {
        try {
            const presignedFiles = await this.sdk.presignFiles(
                this.siteId,
                deploy.id,
                deploy.files.filter(f => f.required).map(f => ({ key: f.key, type: f.type }))
            );

            const filesToUpload = await Promise.all(
                presignedFiles.map(async file => {
                    const abs = files.find(f => f.key === file.key).abs;
                    file.content = await fs.readFile(abs);
                    return file;
                })
            );

            await Promise.all(
                filesToUpload.map(async file => {
                    await this.sdk.uploadPresignedFile(file.presigned, file.content);
                    this.logger.success(file.key);
                })
            );
        } catch (err) {
            this.checkNetworkError(err);
            throw err;
        }
    }

    async createZip(folderToZip, outputPath) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outputPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            output.on("close", () => {
                this.logger.success("Function archive created!");
                resolve();
            });

            archive.on("warning", err => {
                if (err.code === "ENOENT") {
                    this.logger.info(err.message);
                } else {
                    this.logger.error(err.message);
                    reject(err);
                }
            });

            archive.on("error", err => {
                this.logger.error(err.message);
                reject(err);
            });

            archive.on("progress", data => {
                this.logger.log(
                    `Processing files ${data.entries.processed}/${data.entries.total}...`
                );
            });

            // pipe archive data to the file
            archive.pipe(output);
            archive.directory(folderToZip, false);
            archive.finalize();
        });
    }

    async ensureBuild(pkg) {
        this.logger.info("Running build...");
        await execa("yarn", ["build"], {
            cwd: pkg.root,
            env: { ...pkg.env, REACT_APP_ENV: "browser" },
            stdio: "inherit"
        });

        if (pkg.ssr === true) {
            if (!get(pkg.package, "scripts.build:ssr")) {
                this.logger.error(
                    `%s doesn't have a script "build:ssr"! This script is mandatory for SSR enabled apps.`,
                    pkg.name
                );
                process.exit(1);
            }

            await execa("yarn", ["build:ssr"], {
                cwd: pkg.root,
                env: { ...pkg.env, REACT_APP_ENV: "ssr" },
                stdio: "inherit"
            });
        }
    }

    async setupSDK() {
        try {
            // check access token (env or home folder)
            let accessToken = this.getAccessToken();
            // if no token - ask for login
            if (!accessToken) {
                this.logger.log(`You are not logged in! Please enter your Personal Access Token.`);
                this.howToCreateAToken();
                await this.ensureToken();
            } else {
                this.instantiateSDK(accessToken);
                if (!(await this.sdk.whoami())) {
                    this.logger.error("The existing token is invalid!");
                    this.howToCreateAToken();
                    await this.ensureToken();
                }
            }
        } catch (err) {
            this.checkNetworkError(err);
        }
    }

    getAccessToken() {
        if (process.env.WEBINY_ACCESS_TOKEN) {
            return process.env.WEBINY_ACCESS_TOKEN;
        }

        if (!fs.pathExistsSync(webinyConfigPath)) {
            return null;
        }

        const config = fs.readJsonSync(webinyConfigPath, { throws: false });
        if (!config) {
            return null;
        }

        return config.accessToken;
    }

    getSiteId() {
        if (process.env.WEBINY_SITE_ID) {
            return process.env.WEBINY_SITE_ID;
        }

        if (!fs.pathExistsSync(projectConfigPath)) {
            return null;
        }

        const config = fs.readJsonSync(projectConfigPath, { throws: false });
        if (!config) {
            return null;
        }

        return config.siteId;
    }

    storeAccessToken(accessToken) {
        fs.ensureFileSync(webinyConfigPath);

        let config = fs.readJsonSync(webinyConfigPath, { throws: false });
        if (!config) {
            config = {};
        }
        config.accessToken = accessToken;

        fs.writeJsonSync(webinyConfigPath, config);
    }

    storeSiteId(siteId) {
        fs.ensureFileSync(projectConfigPath);

        let config = fs.readJsonSync(projectConfigPath, { throws: false });
        if (!config) {
            config = {};
        }
        config.siteId = siteId;

        fs.writeJsonSync(projectConfigPath, config);
    }

    instantiateSDK(accessToken) {
        this.sdk = new WebinyCloudSDK({ token: accessToken });
    }

    askForToken() {
        return inquirer.prompt([
            {
                type: "input",
                name: "accessToken",
                message: `Personal Access Token:`,
                validate: async accessToken => {
                    if (!accessToken.trim()) {
                        return "Please enter your token!";
                    }
                    this.instantiateSDK(accessToken);
                    ui.updateBottomBar("Verifying token...");
                    const user = await this.sdk.whoami();

                    if (!user) {
                        return "The provided token is invalid!";
                    }
                    return true;
                }
            }
        ]);
    }

    askForSite() {
        return inquirer.prompt([
            {
                type: "list",
                name: "siteId",
                message: "Which site are you deploying?",
                choices: async () => {
                    const sites = await this.sdk.sites();
                    return sites.map(site => ({
                        name: `${site.name} (${site.customHostname || site.freeHostname})`,
                        value: site.id
                    }));
                }
            }
        ]);
    }

    async ensureToken() {
        const { accessToken } = await this.askForToken();
        this.storeAccessToken(accessToken);
    }

    howToCreateAToken() {
        this.logger.info(
            `To create a token, log into your Webiny account and create a token in the account settings.`
        );
    }

    checkNetworkError(err) {
        if (err.code === "ECONNREFUSED") {
            this.logger.error(err.message);
            process.exit(1);
        }
    }
}
