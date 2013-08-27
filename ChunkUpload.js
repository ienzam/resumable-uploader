(function(window, $) {
    "use strict";

    var Uploader = function(fileElem, options) {
        this._fileElem = fileElem;
        this._setState('created');
        this._options = options;
    };

    Uploader.canUploadInChunk = function() {
        if (window.File && window.FileReader && window.FileList && window.Blob && window.Blob.prototype.slice) {
            return true;
        } else {
            return false;
        }
    };

    Uploader.prototype = {
        /**
         * Takes anything as first parameter
         * If the parameter is a function it is executed and the value is returned
         * Else the parameter is returned
         *
         * @param {Function|Object} val
         * @returns {Object}
         */
        _toVal: function(val) {
            if (typeof val === 'function') {
                val = val();
            }
            return val;
        },
        /**
         * Takes a list of arrays and strings (can be mixed)
         * and returns a query string
         *
         * @returns {String}
         */
        _toQueryString: function() {
            var queryString = '';
            for (var i = 0; i < arguments.length; i++) {
                var params = arguments[i];
                var qString = '';
                if (typeof params === 'string') {
                    qString = params;
                } else {
                    qString = $.param(params);
                }
                if (!qString.length) {
                    continue;
                }
                if (queryString.length) {
                    queryString += '&';
                }
                queryString += qString;
            }
            return queryString;
        },
        _sendRequest: function(options, params, doneFunc, failFunc) {
            options.url = this._getOption('baseUrl') + (options.url || '');

            if (params instanceof Blob) {
                var urlParams = this._toQueryString(options.data || {}, this._getOption('commonData') || {});
                options.url += ((options.url.indexOf('?') === -1) ? '?' : '&') + urlParams;
                options.data = params;
            } else {
                options.data = this._toQueryString(params, options.data || {}, this._getOption('commonData') || {});
            }
            options.processData = false;

            var self = this;
            return $.ajax(
                    options
                    ).done(function() {
                doneFunc.apply(self, arguments);
            }).fail(function(xhr) {
                if (xhr.status === 0) {
                    return;
                }
                failFunc.apply(self, arguments);
            });
        },
        _trigger: function(name, params) {
            $(this).trigger(name, params);
            $(this._fileElem).trigger(name, params);
        },
        _getOptions: function() {
            return this._options;
        },
        _getOption: function(name) {
            return this._getOptions()[name];
        },
        _setState: function(state) {
            this._state = state;
            return this;
        },
        _getState: function() {
            return this._state;
        },
        _isInState: function(states) {
            if (typeof states === 'string') {
                states = [states];
            }
            return $.inArray(this._getState(), states) !== -1;
        },
        _start: function() {
            if (!this._isInState(['created', 'aborted'])) {
                this._trigger('error', ['already-started']);
                return;
            }
            if (!(this._fileElem && this._fileElem.files[0])) {
                this._trigger('error', ['no-file']);
                return;
            }
            this._file = this._fileElem.files[0];
            this._setState('starting');

            var initOptions = this._getOption('init');
            var nameKey = initOptions['fileNameKey'];
            var sizeKey = initOptions['fileSizeKey'];
            var params = {};
            params[nameKey] = this._file.name;
            params[sizeKey] = this._file.size;

            this._sendRequest(initOptions, params, function(data) {
                $.extend(this._getOptions(), data.options || {});
                if (this._isInState('aborting')) {
                    this._abort();
                } else {
                    this._startUpload();
                }
            }, function(jqXHR) {
                this._setState('created');
                this._trigger('error', ['init-error', jqXHR]);
            });
        },
        _startOrResume: function() {
            if (this._isInState(['created', 'aborted'])) {
                this._start();
            } else if (this._isInState(['pausing', 'paused'])) {
                this._resumeUpload();
            } else {
                // NOTE: may throw some error here
            }
        },
        _startUpload: function() {
            if (!this._isInState(['starting', 'pausing', 'paused'])) {
                // NOTE: may throw some error here
                return;
            }
            var chunkSize = this._getOption('chunk')['size'];
            var totalSize = this._file.size;
            var numOfChunks = Math.ceil(totalSize / chunkSize);

            this._chunks = new Array(numOfChunks);
            this._upChunkIds = [];
            this._pausedChunkIds = [];

            if (!this._isInState('starting')) {
                // upload only if it is not paused
                this._setState('uploading');
                this._retried = 0;

                while (this._processNextChunk())
                    ;
            }
        },
        _resumeUpload: function() {
            if (!this._isInState(['pausing', 'paused'])) {
                // NOTE: may throw some error here
                return;
            }

            this._setState('uploading');
            this._retried = 0;

            for (var i = 0; i < this._pausedChunkIds.length; i++) {
                this._uploadChunk(this._pausedChunkIds[i], false);
            }
            this._pausedChunkIds = [];

            while (this._processNextChunk())
                ;
        },
        _processNextChunk: function() {
            if (!this._isInState('uploading')) {
                return false;
            }
            if (this._upChunkIds.length >= this._getOption('maxParallel')) {
                return false;
            }

            this._nextChunkId = this._nextChunkId || 0;
            if (this._nextChunkId >= this._chunks.length) {
                if (this._upChunkIds.length === 0) {
                    this._complete();//todo
                }
                return false;
            }

            this._uploadChunk(this._nextChunkId, false);
            this._nextChunkId++;
            return true;
        },
        _uploadChunk: function(chunkId, signed) {
            this._addToUpChunkIds(chunkId);
            if (!signed && typeof this._getOption('chunk')['sign'] !== 'undefined') {
                this._signChunk(chunkId);
            } else {
                this._doUploadChunk(chunkId);
            }
        },
        _signChunk: function(chunkId) {
            var chunkIdKey = this._getOption('chunk')['chunkIdKey'];
            var params = {};
            params[chunkIdKey] = chunkId;
            this._sendRequest(this._getOption('chunk')['sign'], params, function(data) {
                $.extend(this._chunks[chunkId], data['options']);
                this._uploadChunk(chunkId, true);
            }, function(jqXHR) {
                this._softPause();
                this._trigger('error', ['sign-error', jqXHR, chunkId]);
            });
        },
        _removeFromUpChunkId: function(chunkId) {
            this._upChunkIds.splice($.inArray(chunkId, this._upChunkIds), 1);
        },
        _addToUpChunkIds: function(chunkId) {
            if ($.inArray(chunkId, this._upChunkIds) === -1) {
                this._upChunkIds.push(chunkId);
            }
        },
        _addToPausedChunkIds: function(chunkId) {
            if ($.inArray(chunkId, this._pausedChunkIds) === -1) {
                this._pausedChunkIds.push(chunkId);
            }
        },
        _doUploadChunk: function(chunkId) {
            var chunkIdKey = this._getOption('chunk')['chunkIdKey'];
            var params = {};
            params[chunkIdKey] = chunkId;
            this._chunks[chunkId]['data'] = this._toQueryString(this._chunks[chunkId]['data'] || '', this._getOption('chunk')['data'], params);

            var chunkSize = this._getOption('chunk')['size'];
            var start = chunkSize * chunkId;
            var end = Math.min(start + chunkSize, this._file.size);
            var blob = this._file.slice(start, end);
            this._chunks[chunkId].xhr = this._sendRequest(this._chunks[chunkId], blob, function() {
                this._retried = 0;
                this._removeFromUpChunkId(chunkId);
                this._processNextChunk();
            }, function(jqXHR) {
                this._retried++;
                if (this._retried > this._getOption('maxRetries')) {
                    this._removeFromUpChunkId(chunkId);
                    this._addToPausedChunkIds(chunkId);
                    this._softPause();
                    this._trigger('error', ['upload-error', jqXHR, chunkId]);
                } else {
                    this._doUploadChunk(chunkId);
                }
            });
        },
        _softPause: function() {
            this._pause(false);
        },
        _hardPause: function() {
            this._pause(true);
        },
        _pause: function(stopUploads) {
            var state = this._getState();
            if (state === 'starting') {
                this._setState('paused');
            } else if (state === 'uploading') {
                if (!stopUploads) {
                    this._setState('pausing');
                } else {
                    for (var i = 0; i < this._upChunkIds.length; i++) {
                        var chunkId = this._upChunkIds[i];
                        if (this._chunks[chunkId].xhr) {
                            this._chunks[chunkId].xhr.abort();
                        }
                        this._addToPausedChunkIds(chunkId);
                    }
                    this._upChunkIds = [];
                    this._setState('paused');
                }
            }
        },
        _complete: function() {
            if (!this._isInState('uploading')) {
                // NOTE: may throw some error here
                return;
            }
            this._setState('completing');

            this._sendRequest(this._getOption('complete'), {}, function() {
                this._trigger('complete', []);
            }, function(jqXHR) {
                this._setState('completed');
                this._trigger('error', ['completion-error', jqXHR]);
            });
        },
        _abort: function() {
            if (this._isInState(['created', 'completing', 'completed', 'aborted'])) {
                // NOTE: may throw some error here
                return;
            }
            if (this._isInState('starting')) {
                this._setState('aborting');
                return;
            }
            this._setState('aborting');
            this._sendRequest(this._getOption('abort'), {}, function(data) {
            }, function(jqXHR) {
                this._setState('aborted');
                this._trigger('error', ['abortion-error', jqXHR]);
            });
        },
        start: function() {
            this._start();
        },
        pause: function(stopUploads) {
            this._pause(stopUploads);
        },
        startOrResume: function() {
            this._startOrResume();
        },
        resume: function() {
            this._resumeUpload();
        },
        abort: function() {
            this._abort();
        }
    };

    window.ChunkUploader = Uploader;

})(window, jQuery);

(function(ChunkUploader, $) {
    "use strict";

    $.fn.chunkUpload = function(options) {
        var opts = $.extend({}, $.fn.chunkUpload.defaults, options);
        this.each(function() {
            var uploader = new ChunkUploader(this, opts);
            var $this = $(this);
            $this.data('__chunk_upload__', uploader);
            var $startButton = $(opts['startButton']);
            var $pauseButton = $(opts['startButton']);
            var $abortButton = $(opts['startButton']);
            $startButton.click(function() {
                uploader.start();
            });
            $pauseButton.click(function() {
                uploader.pause();
            });
            $abortButton.click(function() {
                uploader.stop();
            });

            (function() {
                $pauseButton.attr('disabled', true).addClass('disabled');
                $abortButton.attr('disabled', true).addClass('disabled');
            })();
            $this.on('start', function() {
                $this.attr('disabled', true).addClass('disabled');
                $startButton.attr('disabled', true).addClass('disabled');
                $pauseButton.attr('disabled', false).removeClass('disabled');
                $abortButton.attr('disabled', false).removeClass('disabled');
            });
            $this.on('pause', function() {
                $startButton.attr('disabled', false).removeClass('disabled');
                $pauseButton.attr('disabled', true).addClass('disabled');
            });
            $this.on('complete', function() {
                $this.attr('disabled', true).addClass('disabled');
                $startButton.attr('disabled', true).addClass('disabled');
                $pauseButton.attr('disabled', true).addClass('disabled');
                $abortButton.attr('disabled', true).addClass('disabled');
            });
            $this.on('abort', function() {
                $this.attr('disabled', false).removeClass('disabled');
                $startButton.attr('disabled', false).removeClass('disabled');
                $pauseButton.attr('disabled', true).addClass('disabled');
                $abortButton.attr('disabled', true).addClass('disabled');
            });
        });
    };

    $.fn.startUpload = function() {
        this.each(function() {
            $(this).data('__chunk_upload__').start();
        });
    };

    $.fn.resumeUpload = function() {
        this.each(function() {
            $(this).data('__chunk_upload__').resume();
        });
    };

    $.fn.startOrResumeUpload = function() {
        this.each(function() {
            $(this).data('__chunk_upload__').startOrResume();
        });
    };

    $.fn.pauseUpload = function(stopUploads) {
        this.each(function() {
            $(this).data('__chunk_upload__').pause(stopUploads);
        });
    };

    $.fn.abortUpload = function() {
        this.each(function() {
            $(this).data('__chunk_upload__').abort();
        });
    };

    $.fn.chunkUpload.defaults = {
        baseUrl: '',
        commonData: {},
        maxParallel: 4,
        maxRetries: 5,
        init: {
            fileNameKey: 'file_name',
            fileSizeKey: 'file_size',
            data: {action: 'init'}
        },
        chunk: {
            size: 1048510, // 1mb
            chunkIdKey: 'chunk_id',
            data: {action: 'upload'}
        },
        complete: {
            data: {action: 'complete'}
        },
        abort: {
            data: {action: 'abort'}
        }
    };
})(ChunkUploader, jQuery);
