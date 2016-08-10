var path = require('path');
var fs = require('fs');
var toFn = require('to-function');
var extend = require('xtend');
var loadMetadata = require('read-metadata').sync;

var DEFAULTS = {
    "sortBy": "date",
    "reverse": false,
    "metadata": {},
    "displayName": "Default",
    "perPage": 10,
    "noPageOne": true,
    "pageContents": new Buffer(''),
    "layout": "default.category.html",
    "first": ":categoryPath/index.html",
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

function paginate(files, metalsmith, done) {
    var metadata = metalsmith.metadata();
    // Iterate over all the paginate names and match with collections.
    var complete = Object.keys(metadata.category).every(function (name) {
        var collection;

        // Catch nested collection reference errors.
        //try {
        //    collection = toFn(name)(metadata)
        //} catch (error) { }
        collection = metadata.category[name];

        if (!collection) {
            done(new TypeError('Collection not found (' + name + ')'))

            return false
        }

        // ignore category collection that has no config file
        if (!metadata.categoryOption[name]) {
            console.log('skip category don\'t have config', name);
            return true; // skip array don't have config options
        }

        var pageOptions, category, categoryPath;

        if (name === 'default') {
            category = 'default';
            categoryPath = './page';
        } else {
            category = name;
            categoryPath = category.replace(/\./g, '/')
        }

        if (metadata.categoryOption[name])
            pageOptions = extend(DEFAULTS, metadata.categoryOption[name]);
        else
            pageOptions = extend(DEFAULTS, metadata.categoryOption['default']);

        var toShow = collection
        var groupBy = toFn(pageOptions.groupBy || groupByPagination)

        if (pageOptions.filter) {
            toShow = collection.filter(toFn(pageOptions.filter))
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
                    categoryDisplayName: pageOptions.displayName,
                    categoryPath: categoryPath,
                    index: length,
                    num: length + 1,
                    pages: pages,
                    files: [],
                    getPages: createPagesUtility(pages, length)
                }

                // Generate the page data.
                var page = extend(pageOptions.pageMetadata, {
                    template: pageOptions.template,
                    layout: pageOptions.layout,
                    contents: pageOptions.pageContents,
                    path: interpolate(pageOptions.path, pagination),
                    metadata: pageOptions.metadata ? pageOptions.metadata : {},
                    pagination: pagination
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

        return true
    })
    
    return complete && done();
}

module.exports = function (opts) {
    var categoryOption = {};
    // doc category options from opts.directory
    if (opts.directory) {
        try {
            var files = fs.readdirSync(opts.directory);
            files.forEach(function (filePath) {
                var fullPath = path.join(opts.directory, filePath);
                var stat = fs.statSync(fullPath);
                if (!stat.isFile()) return;
                var key = filePath.substr(0, filePath.lastIndexOf('.')); // remove '.json'
                if (key === 'default')
                    key = 'default';
                categoryOption[key] = loadMetadata(fullPath);
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
            console.log(ex);
        }
    }

    var categoryFilePrefix = 'category' + path.sep;
    var metadataFilePrefix = 'metadata' + path.sep;
    return function (files, metalsmith, done) {
        var metadata = metalsmith.metadata();
        var category = {
            default: []
        };
        metadata.category = category;
        metadata.categoryOption = categoryOption;

        // only process file has category metadata
        for (var filePath in files) {
            if (!files.hasOwnProperty(filePath))
                continue;
            
            // remove category file from metalsmith's files
            if (filePath.startsWith(categoryFilePrefix)) {
                delete files[filePath];
                continue;
            }

            // TODO remove metadata file SHOULD NOT BE HERE
            if (filePath.startsWith(metadataFilePrefix)) {
                delete files[filePath];
                continue;
            }

            var data = files[filePath];            
            filePath = filePath.replace(/\\/g, '/'); // replace all \ with /

            // add all content file to flat map
            if (!data.category)
                continue; // skip file with no category in metadata            
            category.default.push(data); // add to default
            data.path = filePath // add them path property
            var categories = data.category.split('.');
            // add content to flat categories map
            for (var i = 0; i < categories.length; i++) {
                var key = categories.slice(0, i + 1).join('.');
                // van add full tree category
                category[key] = category[key] || [];
                category[key].push(data);
            }
        }

        // sort category
        for (var key in metadata.category) {
            var settings = categoryOption[key];
            if (!settings)
                settings = categoryOption['default'];
            var sort = settings.sortBy || 'date';
            var col = metadata.category[key];

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

        return paginate(files, metalsmith, done);
    }
}