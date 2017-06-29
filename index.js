var path = require('path');
var fs = require('fs');
var util = require('util');
var toFn = require('to-function');
var extend = require('xtend');
var loadMetadata = require('read-metadata').sync;

var DEFAULTS = {
    "sortBy": "date",
    "reverse": true,
    "metadata": {},
    "displayName": "Root",
    "perPage": 10,
    "noPageOne": true,
    "pageContents": new Buffer(''),
    "layout": "default.category.html",
    "first": ":categoryPath",
    "path": ":categoryPath/page/:num/index.html"
}

function existsSync(filePath) {
    try {
        fs.statSync(filePath);
    } catch (err) {
        if (err.code == 'ENOENT') return false;
    }
    return true;
};

/**
 * Interpolate the page path with pagination variables.
 *
 * @param  {String} path
 * @param  {Object} data
 * @return {String}
 */
function interpolate(path, data) {
    return path.replace(/:(\w+)/g, function (match, param) {
        return data[param]
    })
}

/**
 * Group by pagination by default.
 *
 * @param  {Object} file
 * @param  {number} index
 * @param  {Object} options
 * @return {number}
 */
function groupByPagination(file, index, options) {
    return Math.ceil((index + 1) / options.perPage)
}

/**
 * Create a "get pages" utility for people to use when rendering.
 *
 * @param  {Array}    pages
 * @param  {number}   index
 * @return {Function}
 */
function createPagesUtility(pages, index) {
    return function getPages(number) {
        var offset = Math.floor(number / 2)
        var start, end

        if (index + offset >= pages.length) {
            start = Math.max(0, pages.length - number)
            end = pages.length
        } else {
            start = Math.max(0, index - offset)
            end = Math.min(start + number, pages.length)
        }

        return pages.slice(start, end)
    }
}

function trimPermanentLink(href) {
    if (href.endsWith('/index.html'))
        return href.slice(0, -11);
    return href;
}

function paginate(files, metalsmith, done, categoryFlatMap, categoryOption) {
    var metadata = metalsmith.metadata();
    // Iterate over all the paginate names and match with collections.
    var complete = Object.keys(categoryFlatMap).every(function (name) {
        var collection;

        // Catch nested collection reference errors.
        //try {
        //    collection = toFn(name)(metadata)
        //} catch (error) { }
        collection = categoryFlatMap[name];

        if (!collection) {
            done(new TypeError('Collection not found (' + name + ')'))
            return false
        }

        // ignore category collection that has no config file
        if (!categoryOption[name]) {
            console.log('skip category don\'t have config', name);
            return true; // skip array don't have config options
        }

        var pageOptions, category, categoryPath;

        if (name === 'root') {
            category = 'root';
            categoryPath = './page';
        } else {
            category = name;
            categoryPath = category.replace(/\./g, '/')
        }

        if (categoryOption[name])
            pageOptions = extend(DEFAULTS, categoryOption[name]);
        else
            pageOptions = extend(DEFAULTS, categoryOption['root']);

        var toShow = collection.files
        var groupBy = toFn(pageOptions.groupBy || groupByPagination)

        if (pageOptions.filter) {
            toShow = collection.files.filter(toFn(pageOptions.filter))
        }

        if (!pageOptions.template && !pageOptions.layout) {
            done(new TypeError('A template or layout is required (' + name + ')'))

            return false
        }

        if (pageOptions.template && pageOptions.layout) {
            done(new TypeError(
                'Template and layout can not be used simultaneosly (' + name + ')'
            ))

            return false
        }

        if (!pageOptions.path) {
            done(new TypeError('The path is required (' + name + ')'))

            return false
        }

        // Can't specify both
        if (pageOptions.noPageOne && !pageOptions.first) {
            done(new TypeError(
                'When `noPageOne` is enabled, a first page must be set (' + name + ')'
            ))

            return false
        }

        // Put a `pages` property on the original collection.
        var pages = collection.pages = []
        var pageMap = {}

        // Sort pages into "categories".
        toShow.forEach(function (file, index) {
            var name = String(groupBy(file, index, pageOptions))

            // Keep pages in the order they are returned. E.g. Allows sorting
            // by published year to work.
            if (!pageMap.hasOwnProperty(name)) {
                // Use the index to calculate pagination, page numbers, etc.
                var length = pages.length

                var pagination = {
                    name: name,
                    category: category,
                    displayName: pageOptions.displayName,
                    categoryPath: categoryPath,
                    index: length,
                    num: length + 1,
                    pages: pages,
                    files: [],
                    getPages: createPagesUtility(pages, length)
                }

                var pagePath = interpolate(pageOptions.path, pagination); 
                // Generate the page data.
                var page = extend(pageOptions.pageMetadata, {
                    template: pageOptions.template,
                    layout: pageOptions.layout,
                    contents: pageOptions.pageContents,
                    href: trimPermanentLink(pagePath),
                    path: pagePath,
                    metadata: pageOptions.metadata || {},
                    pagination: pagination,
                    AllCategory: metadata.AllCategory
                })

                // Copy collection metadata onto every page "collection".
                pagination.files.metadata = collection.metadata

                if (length === 0) {
                    if (!pageOptions.noPageOne) {
                        files[page.path] = page
                    }

                    if (pageOptions.first) {
                        // Extend the "first page" over the top of "page one".
                        page = extend(page, {
                            path: interpolate(pageOptions.first, page.pagination)
                        })

                        files[page.path] = page
                    }
                } else {
                    files[page.path] = page

                    page.pagination.previous = pages[length - 1]
                    pages[length - 1].pagination.next = page
                }

                pages.push(page)
                pageMap[name] = pagination
            }

            // Files are kept sorted within their own category.
            pageMap[name].files.push(file)
        })

        // Add page utilities.
        pages.forEach(function (page, index) {
            page.pagination.first = pages[0]
            page.pagination.last = pages[pages.length - 1]
        })
        //console.log('pages', pages);
        return true
    })

    return complete && done();
}

module.exports = function (opts) {
    return function (files, metalsmith, done) {
        var metadata = metalsmith.metadata();
        var categoryFilePrefix = 'metadata' + path.sep + 'category' + path.sep;

        var categoryFlatMap = {
            root: {
                category: 'root',
                categoryDisplayName: 'Root',
                files: [],
            }
        };
        var categoryOptionMap = {};

        // doc category options from opts.directory
        if (opts.directory) {
            try {
                var optionfiles = fs.readdirSync(opts.directory);
                optionfiles.forEach(function (filePath) {
                    var fullPath = path.join(opts.directory, filePath);
                    var stat = fs.statSync(fullPath);
                    if (!stat.isFile()) return;
                    var key = filePath.substr(0, filePath.lastIndexOf('.')); // remove '.json'
                    categoryOptionMap[key] = loadMetadata(fullPath);
                });

                // normalize category options
                /*
                var keys = [];
                for (var key in categoryOption) {
                    if (!categoryOption.hasOwnProperty(key)) continue;
                    keys.push(key);
                }

                keys.sort();

                for (var key in categoryOption) {
                    var terms = key.split('.');
                    terms.pop(); // remove last category chunk (already had options)
                    for (var i = 0; i < terms.length; i++) {
                        var checkKey = terms.slice(0, i + 1).join('.');
                        var option = categoryOption[checkKey];
                        if (option) continue;
                        if (i === 0) {
                            categoryOption[checkKey] = categoryOption['default'];
                        } else {
                            categoryOption[checkKey] = categoryOption[terms.slice(0, i).join('.')];
                        }
                    }
                }
                */
            } catch (ex) {
            }
        }

        // only process file has category metadata
        for (var filePath in files) {
            if (!files.hasOwnProperty(filePath)) {
                continue;
            }

            // remove category file from metalsmith's files
            if (filePath.startsWith(categoryFilePrefix)) {
                delete files[filePath];
                continue;
            }

            var data = files[filePath];
            filePath = filePath.replace(/\\/g, '/'); // replace all \ with /

            // add all content file to flat map
            if (!data.category) {
                continue; // skip file with no category in metadata
            }

            categoryFlatMap['root'].files.push(data); // add to default

            data.path = filePath // add them path property

            var categoryChunks = data.category.split('.');
            var categoryChunkLength = categoryChunks.length;
            // add content to flat categories map
            for (var i = 0; i < categoryChunkLength; i++) {
                var key = categoryChunks.join('.');
                // van add full tree category
                categoryFlatMap[key] = categoryFlatMap[key] || {
                    category: key,
                    files: [],
                };

                categoryFlatMap[key].files.push(data);
                categoryChunks.pop();
            }
        }

        var rootTree = Object.assign({}, DEFAULTS);
        rootTree.category = 'root';
        rootTree.categoryDisplayName = 'Root';
        rootTree.children = [];
        rootTree.parent = null;
        rootTree.files = categoryFlatMap['root'].files;

        // sort category, assign metadata
        for (var key in categoryFlatMap) {
            var settings = categoryOptionMap[key];
            categoryFlatMap[key]['AllCategory'] = rootTree;
            if (!settings) {
                //settings = categoryOption['default'];
                //console.log('null setting', key, categoryOption);
                settings = Object.assign({}, DEFAULTS);
            }
            // fix if category don't have setting, get setting from parent whose have setting

            for (var settingKey in settings) {
                if (!settings.hasOwnProperty(settingKey)) continue;
                if (settingKey === 'files') continue;
                if (settingKey === 'parent') continue;
                if (settingKey === 'children') continue;
                if (settingKey === 'href') continue;

                categoryFlatMap[key][settingKey] = settings[settingKey];
            }

            categoryFlatMap[key]['category'] = key;
            // href property
            var categoryPath = (key === 'root') ? './page' : key.replace(/\./g, '/');
            categoryFlatMap[key].categoryPath = categoryPath;
            categoryFlatMap[key].href = trimPermanentLink(interpolate(settings.first, categoryFlatMap[key]));

            var sort = settings.sortBy || 'date';
            var col = categoryFlatMap[key].files;

            if ('function' == typeof sort) {
                col.sort(sort);
            } else {
                col.sort(function (a, b) {
                    a = a[sort];
                    b = b[sort];
                    if (!a && !b) return 0;
                    if (!a) return -1;
                    if (!b) return 1;
                    if (b > a) return -1;
                    if (a > b) return 1;
                    return 0;
                });
            }

            if (settings.reverse) col.reverse();
        }

        // create categoryTree
        var categoryKeys = Object.keys(categoryFlatMap);
        categoryKeys.sort();
        categoryKeys.forEach(function (key) {
            var chunks = key.split('.');

            var category = categoryFlatMap[key];
            if (chunks.length == 1) {
                // ignore root
                if (key != 'root') {
                    category.children = [];
                    category.parent = rootTree;
                    rootTree.children.push(category);
                }
            } else {
                chunks.pop();
                var parentNode = rootTree;
                var count = 0;
                chunks.forEach(function (chunkName) {
                    count++;
                    var fullCategoryName = chunks.slice(0, count).join('.');
                    parentNode.children.some(function (node) {
                        if (node.category == fullCategoryName) {
                            parentNode = node;
                            return true;
                        }
                        return false;
                    });
                });

                category.children = [];
                category.parent = rootTree;
                parentNode.children.push(category);
            }
        });

        //console.log('ROOT TREEEE', util.inspect(rootTree, { depth: 4 }));
        metadata.AllCategory = rootTree;


        return paginate(files, metalsmith, done, categoryFlatMap, categoryOptionMap);
    }
}
