// @flow
import * as React from "react";
import { pure } from "recompose";
import { Query } from "react-apollo";
import { withCms } from "webiny-app-cms/context";
import { loadPages } from "./graphql";
import { getPlugins } from "webiny-plugins";
import { get } from "lodash";

const PagesList = pure(({ data = {}, cms: { theme } }: Object = {}) => {
    const { component, ...vars } = data;
    const components = getPlugins("cms-element-pages-list-component");
    const pageList = components.find(cmp => cmp.name === component);

    if (!pageList) {
        return "Selected page list component not found!";
    }

    const { component: ListComponent } = pageList;

    if (!ListComponent) {
        return "You must select a component to render your list!";
    }

    let sort = null;
    if (vars.sortBy) {
        sort = { [vars.sortBy]: vars.sortDirection || -1 };
    }

    const variables = {
        category: vars.category,
        sort,
        tags: vars.tags,
        tagsRule: vars.tagsRule,
        perPage: parseInt(vars.resultsPerPage),
        pagesLimit: parseInt(vars.pagesLimit),
        page: 1
    };

    return (
        <Query query={loadPages} variables={variables}>
            {({ data, loading, refetch }) => {
                if (loading) {
                    return "Loading...";
                }

                const pages = get(data, "cms.listPublishedPages");

                if (!pages || !pages.data.length) {
                    return "No pages match the criteria.";
                }

                let prevPage = null;
                if (pages.meta.previousPage !== null) {
                    prevPage = () => refetch({ ...variables, page: pages.meta.previousPage });
                }

                let nextPage = null;
                if (pages.meta.nextPage !== null) {
                    if (!variables.pagesLimit || variables.pagesLimit >= pages.meta.nextPage) {
                        nextPage = () => refetch({ ...variables, page: pages.meta.nextPage });
                    }
                }

                return (
                    <ListComponent
                        {...pages}
                        nextPage={nextPage}
                        prevPage={prevPage}
                        theme={theme}
                    />
                );
            }}
        </Query>
    );
});

export default withCms()(PagesList);
