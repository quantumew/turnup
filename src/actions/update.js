const Immutable = require('immutable')
const inquirer = require('inquirer')
const chalk = require('chalk')
const formatPackage = require('format-package')
const async = require('async')
const packages = require('../packages')
const { errorTypes, fatal } = require('../errors')
const { notify } = require('../logging')
const { promisify } = require('util')

const ACTION = 'turnup.update'
const ALL_ACTION = 'turnup.update.all'

const promptUserForRepos = repos => inquirer.prompt([{
  type: 'checkbox',
  name: 'repos',
  message: 'Which repositories would you like to update?',
  choices: repos,
  pageSize: 20
}])

const getDepString = (repo) => {
  const rel = repo.dependencyRelationship

  return `${rel.packageName}@${rel.packageVersion}`
}

const getCommitMessage = (repo, action) => {
  if (action === ACTION) {
    const rel = repo.dependencyRelationship

    return `[turnup] Auto update of ${rel.type} dependency ${getDepString(repo)}`
  }

  return `[turnup] Auto update of package dependencies`
}

const getPullRequest = (repo, action) => {
  const turnupNotice = 'This PR was automatically generated by the `turnup` [CLI](https://npmjs.com/turnup).'
  const disclaimer = '**Note**: formatting may have changed for package.json. It is processed using [format-package](https://www.npmjs.com/package/format-package).'
  let body = `Update the package.json dependencies within specified range. ${turnupNotice}\n\n${disclaimer}`.trim()
  let title = 'Update Dependencies'

  if (action === ACTION) {
    const depString = getDepString(repo)
    title = `Update Dependency - ${depString}`
    body = `Update the package.json dependency for \`${depString}\`. ${turnupNotice}\n\n${disclaimer}`.trim()
  }

  return {
    body,
    title
  }
}

const updateRepository = async (adapter, repo, packageName, packageVersion, options = {}) => {
  let repository = repo
  notify(ACTION, `Updating ${chalk.italic(repository.fullName)}`)

  const branchName = `turnup/${packageName}@${packageVersion}`
  const packageDef = repository.packageDefinition.decoded

  if (repository.dependencyRelationship.type === 'dev') {
    packageDef.devDependencies[packageName] = packageVersion
  } else {
    packageDef.dependencies[packageName] = packageVersion
  }

  commitUpdates(ACTION, adapter, options, repository, branchName, packageDef, packages.lockfile.create)
}

const updateRepositoryAll = async (adapter, repository, options) => {
  notify(ALL_ACTION, `Running npm update against ${chalk.italic(repository.fullName)}`)
  const branchName = `turnup/update-all`
  const packageDef = repository.packageDefinition.decoded

  commitUpdates(ALL_ACTION, adapter, options, repository, branchName, packageDef, packages.lockfile.update)
}

const commitUpdates = async (action, adapter, options, repository, branchName, packageDef, create) => {
  const formattedPackageDef = await formatPackage(packageDef)

  let updatedLockFile

  if (!options.noLockfile) {
    notify(action, 'Generating lockfile.')
    let currentLockFile = await adapter.fetchLockfileDefinition(repository)

    if (currentLockFile !== undefined) {
      repository = repository.set('lockfileEntity', currentLockFile)
      updatedLockFile = await create(formattedPackageDef, currentLockFile.packageManager, options.registry)
    }
  }

  notify(action, 'Creating branch.')
  await adapter.createBranch(repository, branchName)

  notify(action, 'Creating commit.')
  await adapter.commitPackageDefinition(
    repository,
    branchName,
    formattedPackageDef,
    updatedLockFile,
    getCommitMessage(repository, action)
  )

  if (!options.noPullRequest) {
    notify(action, 'Creating pull request.')
    await adapter.createPullRequest(repository, branchName, getPullRequest(repository))
  }
}

const fetchRepositories = async (adapter, options) => {
  const { repos = [], owner } = options
  let repositories = Immutable.List()

  if (repos.length > 0) {
    repositories = repositories.concat(await adapter.fetchRepositories(repos))
  }

  if (typeof owner === 'string' && owner.length > 0) {
    repositories = repositories.concat(await adapter.fetchRepositoriesByOwner(owner))
  }

  return repositories.reduce((reduction, value) => {
    if (!reduction.find(repo => repo.fullName === value.fullName)) {
      return reduction.push(value)
    }
    return reduction
  }, Immutable.List())
}

const pluralizeRepo = (repoList) => {
  return `${chalk.bold(repoList.size)} repositor${repoList.size === 1 ? 'y' : 'ies'}`
}

const update = async (packageString, adapter, options = {}) => {
  notify(ACTION, `Using adapter ${adapter.getName()}.`)

  try {
    const parsedPackage = await packages.parse.parsePackage(packageString)
    const parsedPackageString = `${parsedPackage.name}@${parsedPackage.version}`
    let repositories = await fetchRepositories(adapter, options)

    if (repositories.size === 0) {
      fatal(ACTION, new errorTypes.NoRepositoriesFoundError())
    } else {
      notify(ACTION, `Found .`)
    }

    repositories = await adapter.fetchPackageDefinitions(repositories)
    repositories = packages.filter.repositoriesByDependencyUpgrade(repositories, parsedPackage.name, parsedPackage.version)

    if (repositories.size === 0) {
      notify(ACTION, 'No repositories require updating.', true)
    } else {
      notify(ACTION, `Found ${pluralizeRepo(repositories)} out of date.`)
    }

    if (!options.continue) {
      const repoChoices = repositories.map(repo => {
        return {
          name: `${repo.packageDefinition.decoded.name} (${repo.dependencyRelationship.type} dependency of ${repo.dependencyRelationship.currentVersion})`,
          value: repo
        }
      }).toJS()

      const answers = await promptUserForRepos(repoChoices)
      repositories = Immutable.List(answers.repos)
    }

    if (repositories.size === 0) {
      notify(ACTION, 'No selected repos.')
      return
    } else {
      notify(ACTION, `Updating ${pluralizeRepo(repositories)} with ${chalk.bold(parsedPackageString)}`)
    }

    await promisify(async.series).call(this, repositories.map(repository => updateRepository.bind(this, adapter, repository, parsedPackage.name, parsedPackage.version, options)).toJS())
  } catch (err) {
    fatal(ACTION, err)
  }
}

const updateAll = async (adapter, options = {}) => {
  notify(ALL_ACTION, `Using adapter ${adapter.getName()}.`)

  try {
    let repositoryList = await fetchRepositories(adapter, options)

    if (repositoryList.size === 0) {
      fatal(ALL_ACTION, new errorTypes.NoRepositoriesFoundError())
    } else {
      notify(ALL_ACTION, `Found ${pluralizeRepo(repositoryList)}.`)
    }

    repositoryList = await adapter.fetchPackageDefinitions(repositoryList)

    if (!options.continue) {
      const repoChoices = repositoryList.map(repo => {
        return {
          name: repo.name,
          value: repo
        }
      }).toJS()

      const answers = await promptUserForRepos(repoChoices)
      repositoryList = Immutable.List(answers.repos)
    }

    await promisify(async.series).call(this, repositoryList.map(repository => updateRepositoryAll.bind(this, adapter, repository, options)).toJS())
  } catch (err) {
    fatal(ALL_ACTION, err)
  }
}


module.exports = {
  update,
  updateAll
}
