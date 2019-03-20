"use strict";

const graphql = require("./graphql.js");
const io = require("io-promise");

// this takes https://developer.github.com/v4/object/repository/
// and normalize it
// return the object cleaned up
function cleanRepository(repo) {
  if (!repo || repo.nameWithOwner === undefined) {
    let e = new Error("Invalid repository object");
    e.param = repo;
    throw e;
  }
  // Register the errors during the transformation
  let errors = {};

  // convert a text file property into a string property
  function convert2Text(name) {
    if (repo[name]) {
      if (typeof repo[name].text === "string"
          && repo[name].text !== "") {
        repo[name] = repo[name].text;
      } else {
        errors[name] = repo[name];
        delete repo[name];
      }
    }
  }
  // convert a JSON property into a proper Object
  function convert2JSON(name) {
    if (repo[name]) {
      try {
        repo[name] = JSON.parse(repo[name].text);
      } catch (e) {
        errors[name] = repo[name];
        delete repo[name];
      }
    }
  }

  // clean up the object by removing null, empty string, empty arrays properties
  function cleanup(obj) {
    if (!obj) return;
    Object.keys(obj).forEach(k => {
      if (Array.isArray(obj[k])
          && obj[k].length === 0) {
            delete obj[k];
      }
      if (obj[k] === "") delete obj[k];
      if (obj[k] === null) delete obj[k];
    })
  }

  ["w3cJson", "preview"].forEach(convert2JSON);

  // normalize w3c.json group
  if (repo.w3cJson && repo.w3cJson.group) {
    let invalid = false;
    let group = repo.w3cJson.group;
    if (typeof group === "string") {
      group = Number.parseInt(group);
      if (group === NaN) invalid = true;
    } else if (Array.isArray(group)) {
      let ng = [];
      group.forEach((g) => {
        let gid = Number.parseInt(g);
        if (gid === NaN) invalid = true;
        ng.push(gid);
      });
      group = ng;
    }
    if (invalid) {
      errors.group = repo.w3cJson.group;
      delete repo.w3cJson.group;
    } else {
      if (Number.isInteger(group)) {
        group = [ group ];
      }
      repo.w3cJson.group = group;
    }
  }

  if (repo.defaultBranch) {
    repo.defaultBranch = repo.defaultBranch.name;
  }
  repo.branchProtectionRules = repo.branchProtectionRules.nodes;
  if (repo.branchProtectionRules) {
    repo.branchProtectionRules.forEach(cleanup);
    if (repo.branchProtectionRules[0] === null) {
      // something went wrong here, so let's clean that up for now, eg w3c/stories
      errors.branchProtectionRules = repo.branchProtectionRules;
      delete repo.branchProtectionRules;
    }
  }
  repo.milestones = repo.milestones.nodes;
  if (repo.milestones) {
    repo.milestones.forEach(cleanup);
    if (repo.milestones[0] === null) {
      // something went wrong here, so let's clean that up for now, eg w3c/stories
      errors.milestones = repo.milestones;
      delete repo.milestones;
    }
  }
  repo.labels = repo.labels.nodes;
  if (repo.labels) {
    try {
      let labels = repo.labels.map(l => l.name);
      repo.labels = labels;
    } catch (e) {
      errors.labels = repo.labels;
      delete repo.labels;
    }
  }

  ["codeOfConduct", "codeOwners", "contributing",
  "license", "readme", "travis"].forEach(convert2Text);
  cleanup(repo);

  if (Object.keys(errors).length > 0) {
    // if we found errors, add them the record
    repo.errors = errors;
  }

  return repo;
}

// the list of fields to fetch
// update cleanRepository as needed if you add a new field
// I expect at least nameWithOwner here
const FIELDS = `
name
nameWithOwner
homepageUrl
isArchived
isPrivate
hasWikiEnabled
hasIssuesEnabled
pushedAt
updatedAt
mergeCommitAllowed
squashMergeAllowed
defaultBranch: defaultBranchRef {
  name
}
branchProtectionRules(first: 5) {
  nodes {
    pattern
    requiredApprovingReviewCount
    requiredStatusCheckContexts
    isAdminEnforced
  }
}
labels(first: 30) {
  nodes {
    name
  }
}
milestones(first: 30) {
  nodes {
    closed
    dueOn
    title
  }
}
codeOwners: object(expression: "HEAD:CODEOWNERS") {
  ... on Blob {
    text
  }
}
w3cJson: object(expression: "HEAD:w3c.json") {
  ... on Blob {
    text
  }
}
contributing: object(expression: "HEAD:CONTRIBUTING.md") {
  ... on Blob {
    text
  }
}
license: object(expression: "HEAD:LICENSE.md") {
  ... on Blob {
    text
  }
}
readme: object(expression: "HEAD:README.md") {
  ... on Blob {
    text
  }
}
codeOfConduct: object(expression: "HEAD:CODE_OF_CONDUCT.md") {
  ... on Blob {
    text
  }
}
preview: object(expression: "HEAD:.pr-preview.json") {
  ... on Blob {
    text
  }
}
travis: object(expression: "HEAD:.travis.yml") {
  ... on Blob {
    text
  }
}`;

async function repository(owner, name) {
    const query = `
    query ($owner: String = "w3c",
           $name: String = "w3c.github.io") {
      repository(owner: $owner, name: $name) {` + FIELDS + ` }
    }
    `;


    let variables = { owner: owner, name: name };
    let repo = await graphql(query, variables);
    return cleanRepository(repo.repository);
}

async function fetchNodes(query, variables, propName) {
  const edgesQuery = (endCursor) => {
    let vars = Object.assign({}, variables);
    console.log("iterate on %s with %s", vars.owner + '/' + vars.name, endCursor);
    if (endCursor) vars.endCursor = endCursor;
    return graphql(query, vars)
     .then(res => {
      if (res.repository === null) {
        throw new Error("Unknown repository " + vars.owner + '/' + vars.name);
      }
      let pageInfo = res.repository[propName].pageInfo;
      let edges = res.repository[propName].edges.map(edge => edge.node);
      if (pageInfo.hasNextPage === true) {
        return io.wait(5000, function () {
          return edgesQuery(pageInfo.endCursor).then(moreEdges =>
                                                     edges.concat(moreEdges));
          });
       } else {
         return edges;
       }
      });
    };
  return edgesQuery().then(repos => {
    // labels are nodes, but we might get more than 30...
    return Promise.all(repos.map(repo => {
      if (repo.labels && repo.labels.length >= 30) {
        return getAllLabels(owner, repo.name).then(labels => {
          repo.labels = labels;
          return repo;
        })
      }
      return repo;
    }));
  });
}

async function getAllLabels(owner, name) {
  const query = `
  query ($owner: String = "w3c",
         $name: String = "w3c.github.io",
         $endCursor: String = null) {
    repository(owner: $owner, name: $name) {
      labels(after: $endCursor, first:50) {
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          node {
            ... labelFragment
          }
        }
      }
    }
  }
  fragment labelFragment on Label { name } `;

  return fetchNodes(query, { owner: owner, name: name }, "labels")
    .then(nodes => nodes.map(node => node.name));
}

function test() {
 getAllLabels("w3c", "csswg-drafts")
  .then(res => {
    console.log(res);
    return res;
  })
  .catch(console.error);
}

// test();


// wishes I can simply write export here...
module.exports = { repository, FIELDS, cleanRepository, getAllLabels };
