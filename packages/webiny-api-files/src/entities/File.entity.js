// @flow
import { Entity } from "webiny-entity";

export interface IFile extends Entity {
    createdBy: ?Entity;
    src: string;
    description: string;
    name: string;
    tags: Array<string>;
}

export function fileFactory(context: Object): Class<IFile> {
    return class File extends Entity {
        static classId = "File";

        createdBy: ?Entity;
        src: string;
        description: string;
        name: string;
        type: string;
        tags: Array<string>;
        constructor() {
            super();

            const { user = {}, security, files } = context;
            const { User } = security.entities;

            this.attr("createdBy")
                .entity(User)
                .setSkipOnPopulate();

            this.attr("size")
                .integer()
                .setValidators("required");
            this.attr("type")
                .char()
                .setValidators("required,maxLength:50");
            this.attr("src")
                .char()
                .setValidators("required,maxLength:200");
            this.attr("name")
                .char()
                .setValidators("required,maxLength:100");
            this.attr("tags")
                .array()
                .onSet(value => {
                    if (Array.isArray(value)) {
                        return value.map(item => item.toLowerCase());
                    }

                    return value;
                })
                .setValidators(tags => {
                    if (Array.isArray(tags)) {
                        if (tags.length > 15) {
                            throw Error("You cannot set more than 15 tags.");
                        }

                        for (let i = 0; i < tags.length; i++) {
                            let tag = tags[i];
                            if (typeof tag !== "string") {
                                throw Error("Tag must be typeof string.");
                            }

                            if (tag.length > 50) {
                                throw Error(`Tag ${tag} is more than 50 characters long.`);
                            }
                        }
                    }
                });

            this.on("beforeCreate", async () => {
                if (!this.src.startsWith("/") || this.src.startsWith("http")) {
                    throw Error(
                        `File "src" must be a relative path, starting with forward slash ("/").`
                    );
                }

                if (await files.entities.File.findOne({ query: { src: this.src } })) {
                    throw Error(`File "src" must be unique. `);
                }

                this.createdBy = user.id;
            });
        }
    };
}
