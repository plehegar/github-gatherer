"use strict";

const graphql = require("./graphql.js");
const io = require("io-promise");
const GH = require("./repository.js");

const { repository, FIELDS, cleanRepository } = GH;

const jsonify = o => JSON.stringify(o, null, 2);


function repositories(owner) {
    const query = `
    query ($login: String = "w3c",
           $endCursor: String = null) {
      organization(login: $login) {
        repositories(after: $endCursor, first: 10) {
          pageInfo {
            endCursor
            hasNextPage
          }
          edges {
            node {
              ... repositoryFragment
            }
          }
        }
      }
    }
    fragment repositoryFragment on Repository {` + FIELDS + ` } `;


    const edgesQuery = (endCursor) => {
      let variables = { login: owner };
      console.log("iterate on %s with %s", owner, endCursor);
      if (endCursor) variables.endCursor = endCursor;
      return graphql(query, variables)
       .then(res => {
         if (res.organization === null) {
           throw new Error("Unknown owner " + owner);
         }
         if (res.organization.repositories === null) {
          throw new Error("No repositories found for owner " + owner);
        }
        let pageInfo = res.organization.repositories.pageInfo;
        let edges = res.organization.repositories.edges.map(edge => cleanRepository(edge.node));
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
    return edgesQuery()
      .then(edges => edges.filter(repo => !repo.isPrivate)) // filter out private repos since we don't want this info to be public
}

function find(repos, repo) {
  let name = repo.nameWithOwner;
  for (let index = 0; index < repos.length; index++) {
    if (repos[index].nameWithOwner === name) {
      return index;
    }
  }
  return -1;
}

// check if a repo is in the array, warm if it isn't
function checkForOld(repos, repo) {
  let name = repo.nameWithOwner;
  let index = find(repos, repo);
  if (index === -1) {
    repos.push(repo);
  } // else retain the new one
}

repositories("w3c")
.then(res => {
  console.log(res.length + " repositories retrieved");
  return res;
}).then(repos => io.save("all-repos.json", jsonify({
  fetchedAt: (new Date()).toISOString(),
  repositories: repos})))
.catch(console.error);

module.exports = repositories;
