const Immutable = require('immutable')
const RepositoryEntity = require('../../domain/repository-entity')
const Api = require('./api')
const async = require('async')
const { promisify } = require('util')

const createRepositoryEntity = raw => {
  return new RepositoryEntity({
    name: raw.name,
    fullName: raw.full_name,
    defaultBranch: raw.default_branch
  })
}

class GitHub {
  constructor(accessToken) {
    this.api = new Api(accessToken)
  }

  getName() {
    return 'GitHub'
  }

  getKey() {
    return 'github'
  }

  async fetchRepositories(names) {
    const repositories = await Promise.all(names.map(this.fetchRepository.bind(this)))
    return Immutable.List(repositories.map(createRepositoryEntity))
  }

  async fetchRepository(name) {
    return this.api.getRepo(name)
  }

  async fetchRepositoriesByOwner(owner) {
    let ownerRepos = await this.api.getUserRepos(owner)

    if (!Array.isArray(ownerRepos) || ownerRepos.length === 0) {
      ownerRepos = await this.api.getOrgRepos(owner)
    }

    return Immutable.List(ownerRepos.map(createRepositoryEntity))
  }

  async fetchPackageDefinitions(repositories) {
    const list = await Promise.all(repositories.map(async repository => {
      try {
        const packageDefinition = await this.getPackageJson(repository)
        return repository.set('packageDefinition', packageDefinition)
      } catch (err) {
        if (err.statusCode === 404) {
          return repository
        } else {
          throw err
        }
      }
    }))

    return Immutable.List(list)
  }

  async getPackageJson(repository) {
    const contents = await this.api.getContents(repository.fullName, 'package.json')
    const decoded = Buffer.from(contents.content, 'base64').toString()

    return {
      decoded: JSON.parse(decoded),
      sha: contents.sha
    }
  }

  async createBranch(repository, branchName) {
    const defaultBranchRef = await this.api.getRef(repository.fullName, repository.defaultBranch)
    const defaultBranchSha = defaultBranchRef.object.sha
    return await this.api.createRef(repository.fullName, branchName, defaultBranchSha)
  }

  async commitPackageDefinition(repository, branchName, packageDefinition, lockFile) {
    const rel = repository.dependencyRelationship

    const queued = [this.api.createContents.bind(
      this.api,
      repository.fullName,
      branchName,
      'package.json',
      repository.packageDefinition.sha,
      packageDefinition,
      `[turnup] Auto update of ${rel.type} dependency ${rel.packageName}@${rel.packageVersion} - package.json`
    )]

    if (lockFile !== undefined) {
      try {
        const lockFileRemote = await this.api.getContents(repository.fullName, 'package-lock.json')
        queued.push(this.api.createContents.bind(
          this.api,
          repository.fullName,
          branchName,
          'package-lock.json',
          lockFileRemote.sha,
          lockFile,
          `[turnup] Auto update of ${rel.type} dependency ${rel.packageName}@${rel.packageVersion} - package-lock.json`
        ))
      } catch (err) {
        console.error(err)
        if (err.statusCode !== 404) {
          throw err
        }
      }
    }

    return await promisify(async.series).call(this, queued)
  }

  async createPullRequest(repository, branchName) {
    const rel = repository.dependencyRelationship
    const depString = `${rel.packageName}@${rel.packageVersion}`
    const title = `Update Dependency - ${depString}`
    const body = (`
Update the package.json dependency for \`${depString}\`. This PR was automatically generated by the \`turnup\` [CLI](https://npmjs.com/turnup).

**Note**: formatting may have changed for package.json. It is processed using [format-package](https://www.npmjs.com/package/format-package).
`).trim()
    return await this.api.createPull(repository.fullName, repository.defaultBranch, branchName, title, body)
  }
}

module.exports = GitHub
